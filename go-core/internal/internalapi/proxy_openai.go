package internalapi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// proxyOpenAI handles the generic OpenAI-compat passthrough branch.
// Streaming requests are line-pumped (the upstream's own SSE events are
// forwarded verbatim), while parsing each event in parallel to extract
// the per-request usage block. Non-streaming requests are forwarded
// as-is and the JSON response is parsed for usage + cost. Mirrors
// bridge/chat/openai-internal.ts:115-216.
func (s *Server) proxyOpenAI(
	w http.ResponseWriter,
	r *http.Request,
	rec *KeyRecord,
	info ProviderInfo,
	req OpenAIRequest,
	body []byte,
	started time.Time,
) {
	upstream := strings.TrimRight(info.Endpoint, "/") + "/chat/completions"
	hreq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstream, bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to build upstream request: "+err.Error(), "server_error", "")
		return
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Accept", "application/json")
	if info.APIKey != "" {
		hreq.Header.Set("Authorization", "Bearer "+info.APIKey)
	}

	resp, err := s.doProxy(r.Context(), info.ProviderName, hreq)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Upstream fetch failed: "+err.Error(), "server_error", "")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		ct, body := readUpstreamFailure(resp)
		writeUpstreamError(w, resp.StatusCode, ct, body)
		return
	}

	if req.Stream {
		s.streamOpenAIPassthrough(w, resp, rec, info, req.Model, started)
		return
	}

	// Non-streaming: forward the body as-is, parse for usage telemetry.
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	const maxRespBody = 32 * 1024 * 1024
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxRespBody))
	_, _ = w.Write(respBody)

	usage := parseOpenAIUsageBlob(respBody)
	cost := s.computeCost(req.Model, usage.PromptTokens, usage.CompletionTokens)
	s.recordCost(rec.ID, req.Model, info.ProviderName, "/v1/chat/completions",
		usage.PromptTokens, usage.CompletionTokens, cost, started)
}

// streamOpenAIPassthrough copies the upstream SSE stream onto the
// downstream response while parsing each frame for usage data. The
// data lines are emitted verbatim — same wire shape as the upstream.
func (s *Server) streamOpenAIPassthrough(
	w http.ResponseWriter,
	resp *http.Response,
	rec *KeyRecord,
	info ProviderInfo,
	model string,
	started time.Time,
) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flushIfPossible(w)

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var lastUsage openAIUsageBlock
	for scanner.Scan() {
		line := scanner.Bytes()
		if _, err := w.Write(append(append([]byte{}, line...), '\n')); err != nil {
			return
		}
		flushIfPossible(w)
		if bytes.HasPrefix(line, []byte("data: ")) {
			payload := bytes.TrimPrefix(line, []byte("data: "))
			if bytes.Equal(bytes.TrimSpace(payload), []byte("[DONE]")) {
				continue
			}
			if u, ok := parseOpenAIUsageFromFrame(payload); ok {
				lastUsage = u
			}
		}
	}

	cost := s.computeCost(model, lastUsage.PromptTokens, lastUsage.CompletionTokens)
	s.recordCost(rec.ID, model, info.ProviderName, "/v1/chat/completions",
		lastUsage.PromptTokens, lastUsage.CompletionTokens, cost, started)
}

// openAIUsageBlock matches the OpenAI `usage` field shape (prompt /
// completion / total tokens). cached_tokens lives on
// prompt_tokens_details.cached_tokens; we keep it separate since the
// recordCost sink subtracts it elsewhere if/when we wire that.
type openAIUsageBlock struct {
	PromptTokens     int `json:"prompt_tokens,omitempty"`
	CompletionTokens int `json:"completion_tokens,omitempty"`
	TotalTokens      int `json:"total_tokens,omitempty"`
}

// parseOpenAIUsageBlob walks the response body looking for the
// top-level `usage` field. Used for non-streaming responses.
func parseOpenAIUsageBlob(body []byte) openAIUsageBlock {
	var wrap struct {
		Usage openAIUsageBlock `json:"usage"`
	}
	_ = json.Unmarshal(body, &wrap)
	return wrap.Usage
}

// parseOpenAIUsageFromFrame inspects one SSE data: frame for the
// trailing `usage` block. OpenAI emits usage on the final frame only
// when the client requested `stream_options.include_usage: true`; we
// surface what's present and fall through otherwise.
func parseOpenAIUsageFromFrame(payload []byte) (openAIUsageBlock, bool) {
	payload = bytes.TrimSpace(payload)
	if len(payload) == 0 || payload[0] != '{' {
		return openAIUsageBlock{}, false
	}
	var f struct {
		Usage *openAIUsageBlock `json:"usage,omitempty"`
	}
	if err := json.Unmarshal(payload, &f); err != nil {
		return openAIUsageBlock{}, false
	}
	if f.Usage == nil {
		return openAIUsageBlock{}, false
	}
	return *f.Usage, true
}
