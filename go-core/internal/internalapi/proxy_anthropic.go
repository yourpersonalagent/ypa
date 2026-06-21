package internalapi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// proxyAnthropic handles the RouteAnthropicAPI branch. The OpenAI →
// Anthropic translation has already happened in OpenAIToAnthropic; we
// JSON-marshal the converted body, POST to provider.endpoint/messages
// with the anthropic-version + x-api-key headers, then transform the
// response back to the OpenAI shape on the way out.
//
// Mirrors bridge/chat/openai-internal.ts:333-497.
func (s *Server) proxyAnthropic(
	w http.ResponseWriter,
	r *http.Request,
	rec *KeyRecord,
	info ProviderInfo,
	originalModel string,
	anReq AnthropicRequest,
	started time.Time,
) {
	body, err := json.Marshal(anReq)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to marshal Anthropic request: "+err.Error(), "server_error", "")
		return
	}
	upstream := strings.TrimRight(info.Endpoint, "/") + "/messages"
	hreq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstream, bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to build upstream request: "+err.Error(), "server_error", "")
		return
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("anthropic-version", "2023-06-01")
	if info.APIKey != "" {
		hreq.Header.Set("x-api-key", info.APIKey)
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

	if anReq.Stream {
		s.streamAnthropicAsOpenAI(w, resp, rec, info, originalModel, started)
		return
	}
	s.respondAnthropicAsOpenAI(w, resp, rec, info, originalModel, started)
}

// respondAnthropicAsOpenAI converts a non-streaming Anthropic response
// into an OpenAI chat.completion shape and writes it to w.
func (s *Server) respondAnthropicAsOpenAI(
	w http.ResponseWriter,
	resp *http.Response,
	rec *KeyRecord,
	info ProviderInfo,
	originalModel string,
	started time.Time,
) {
	const maxRespBody = 32 * 1024 * 1024
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxRespBody))

	var an anthropicNonStream
	if err := json.Unmarshal(respBody, &an); err != nil {
		writeError(w, http.StatusBadGateway, "Failed to decode upstream Anthropic response: "+err.Error(), "server_error", "")
		return
	}

	var text strings.Builder
	for _, blk := range an.Content {
		if blk.Type == "text" {
			text.WriteString(blk.Text)
		}
	}

	resOut := openAIChatCompletion{
		ID:      generateID(),
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   originalModel,
		Choices: []openAIChoice{{
			Index:        0,
			Message:      &openAIChoiceMessage{Role: "assistant", Content: text.String()},
			FinishReason: AnthropicStopReasonToOpenAI(an.StopReason),
		}},
		Usage: openAIUsageBlock{
			PromptTokens:     an.Usage.InputTokens,
			CompletionTokens: an.Usage.OutputTokens,
			TotalTokens:      an.Usage.InputTokens + an.Usage.OutputTokens,
		},
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(resOut)

	cost := s.computeCost(originalModel, an.Usage.InputTokens, an.Usage.OutputTokens)
	s.recordCost(rec.ID, originalModel, info.ProviderName, "/v1/chat/completions",
		an.Usage.InputTokens, an.Usage.OutputTokens, cost, started)
}

// streamAnthropicAsOpenAI reads the Anthropic SSE stream and emits
// OpenAI-shaped chat.completion.chunk frames.
//
// Anthropic events of interest:
//
//	message_start          → first delta carries {role:"assistant"} (line 414 of JS)
//	content_block_delta    → text delta → {choices:[{delta:{content:"…"}}]}
//	message_delta          → carries usage.output_tokens running tally
//	message_stop / end     → terminator
//
// The Anthropic frames arrive as `event: <name>\ndata: <json>\n\n`.
// We parse each event for shape, but the downstream wire is always
// the OpenAI chunk shape.
func (s *Server) streamAnthropicAsOpenAI(
	w http.ResponseWriter,
	resp *http.Response,
	rec *KeyRecord,
	info ProviderInfo,
	originalModel string,
	started time.Time,
) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flushIfPossible(w)

	id := generateID()
	created := time.Now().Unix()

	// Initial frame — sets the role on the choices[0].delta block so
	// the OpenAI SDK clients can stamp the message header. Same as the
	// JS line 414-422.
	roleFrame := openAIStreamFrame{
		ID:      id,
		Object:  "chat.completion.chunk",
		Created: created,
		Model:   originalModel,
		Choices: []openAIStreamChoice{{
			Index: 0,
			Delta: openAIStreamDelta{Role: "assistant", Content: ""},
		}},
	}
	writeFrame(w, roleFrame)

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var currentEvent string
	var inputTokens, outputTokens int
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event:") {
			currentEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		switch currentEvent {
		case "content_block_delta":
			var ev struct {
				Delta struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"delta"`
			}
			if err := json.Unmarshal([]byte(payload), &ev); err == nil && ev.Delta.Text != "" {
				writeFrame(w, openAIStreamFrame{
					ID:      id,
					Object:  "chat.completion.chunk",
					Created: created,
					Model:   originalModel,
					Choices: []openAIStreamChoice{{
						Index: 0,
						Delta: openAIStreamDelta{Content: ev.Delta.Text},
					}},
				})
			}
		case "message_start":
			var ev struct {
				Message struct {
					Usage struct {
						InputTokens int `json:"input_tokens"`
					} `json:"usage"`
				} `json:"message"`
			}
			if err := json.Unmarshal([]byte(payload), &ev); err == nil {
				inputTokens = ev.Message.Usage.InputTokens
			}
		case "message_delta":
			var ev struct {
				Usage struct {
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			}
			if err := json.Unmarshal([]byte(payload), &ev); err == nil && ev.Usage.OutputTokens > 0 {
				outputTokens = ev.Usage.OutputTokens
			}
		}
	}

	// Final usage frame + [DONE].
	usageFrame := openAIStreamFrame{
		ID:      id,
		Object:  "chat.completion.chunk",
		Created: created,
		Model:   originalModel,
		Choices: []openAIStreamChoice{},
		Usage: &openAIUsageBlock{
			PromptTokens:     inputTokens,
			CompletionTokens: outputTokens,
			TotalTokens:      inputTokens + outputTokens,
		},
	}
	writeFrame(w, usageFrame)
	_, _ = w.Write([]byte("data: [DONE]\n\n"))
	flushIfPossible(w)

	cost := s.computeCost(originalModel, inputTokens, outputTokens)
	s.recordCost(rec.ID, originalModel, info.ProviderName, "/v1/chat/completions",
		inputTokens, outputTokens, cost, started)
}

// writeFrame marshals one OpenAI stream frame and writes it as a
// `data: <json>\n\n` SSE line.
func writeFrame(w http.ResponseWriter, frame openAIStreamFrame) {
	payload, err := json.Marshal(frame)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", payload)
	flushIfPossible(w)
}

// openAIStreamFrame is the chat.completion.chunk shape (streaming).
type openAIStreamFrame struct {
	ID      string               `json:"id"`
	Object  string               `json:"object"`
	Created int64                `json:"created"`
	Model   string               `json:"model"`
	Choices []openAIStreamChoice `json:"choices"`
	Usage   *openAIUsageBlock    `json:"usage,omitempty"`
}

type openAIStreamChoice struct {
	Index        int               `json:"index"`
	Delta        openAIStreamDelta `json:"delta"`
	FinishReason string            `json:"finish_reason,omitempty"`
}

type openAIStreamDelta struct {
	Role    string `json:"role,omitempty"`
	Content string `json:"content,omitempty"`
}

// openAIChatCompletion is the chat.completion shape (non-streaming).
type openAIChatCompletion struct {
	ID      string           `json:"id"`
	Object  string           `json:"object"`
	Created int64            `json:"created"`
	Model   string           `json:"model"`
	Choices []openAIChoice   `json:"choices"`
	Usage   openAIUsageBlock `json:"usage"`
}

type openAIChoice struct {
	Index        int                  `json:"index"`
	Message      *openAIChoiceMessage `json:"message,omitempty"`
	FinishReason string               `json:"finish_reason,omitempty"`
}

type openAIChoiceMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// anthropicNonStream is the trimmed view of the Anthropic /messages
// non-streaming response — only the fields we surface in the OpenAI
// envelope.
type anthropicNonStream struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}
