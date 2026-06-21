package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// OpenAIProvider implements Provider for any OpenAI-compatible Chat
// Completions endpoint (api.openai.com, OpenRouter, Groq, Ollama-OAI,
// vLLM, etc.). Wire shape: POST {BaseURL}/v1/chat/completions with the
// standard `{model, messages, tools, stream:true}` body, response is
// SSE with `data: {choices:[{delta:{content?, tool_calls?}, finish_reason?}]}`
// frames terminated by `data: [DONE]`.
//
// This is a 1:1 port of streamDirectOpenAI from bridge/tools/stream.ts.
// The function-level multi-turn loop, history persistence, and cost
// accounting that lived in the TS version are now in loop.go; this
// file only owns the per-turn "render request, parse SSE" surface.
type OpenAIProvider struct {
	BaseURL string // e.g. "https://api.openai.com" — defaults to OpenAI proper
	Model   string // default model id; opts.Model overrides per-call

	// usage accumulates token counts across every turn of a single
	// Run loop. Populated from the final stream frame's `usage`
	// field when stream_options.include_usage is set on the request
	// (default for the daemon). Mutex protects concurrent reads from
	// the route (after Run) and writes from Stream (during Run).
	usage   Usage
	usageMu sync.Mutex
}

// Name returns "openai" — used as a tag on emitted chunks.
func (p *OpenAIProvider) Name() string { return "openai" }

// Endpoint returns the full /v1/chat/completions URL. A trailing slash
// on BaseURL is tolerated.
func (p *OpenAIProvider) Endpoint() string {
	base := p.BaseURL
	if base == "" {
		base = "https://api.openai.com"
	}
	base = strings.TrimRight(base, "/")
	return base + "/v1/chat/completions"
}

// Headers sets the standard auth + JSON + SSE headers. apiKey may be
// empty for local endpoints (Ollama / vLLM) — Authorization is then
// omitted entirely so the upstream doesn't reject "Bearer ".
func (p *OpenAIProvider) Headers(apiKey string) http.Header {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("Accept", "text/event-stream")
	if apiKey != "" {
		h.Set("Authorization", "Bearer "+apiKey)
	}
	return h
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

// oaMessage is the request-side message shape OpenAI expects.
//
// Content is `any` because:
//   - role=user/system/assistant: string
//   - role=tool: string (the tool result)
//   - role=assistant when ToolCalls is set: nil is allowed
//
// ToolCalls is only emitted on assistant messages that called tools.
type oaMessage struct {
	Role       string       `json:"role"`
	Content    any          `json:"content,omitempty"`
	ToolCalls  []oaToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
}

type oaToolCall struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"` // always "function"
	Function oaToolCallFunc `json:"function"`
}

type oaToolCallFunc struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // JSON-encoded string, per OpenAI spec
}

type oaToolDef struct {
	Type     string       `json:"type"` // always "function"
	Function oaToolDefFn  `json:"function"`
}

type oaToolDefFn struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters"`
}

type oaRequest struct {
	Model         string             `json:"model"`
	Messages      []oaMessage        `json:"messages"`
	Tools         []oaToolDef        `json:"tools,omitempty"`
	Stream        bool               `json:"stream"`
	MaxTokens     int                `json:"max_tokens,omitempty"`
	StreamOptions *oaStreamOptions   `json:"stream_options,omitempty"`
}

// oaStreamOptions is OpenAI's per-request switch for surfacing token
// usage in the SSE stream. Setting include_usage=true makes the API
// append a final `usage` frame after `data: [DONE]` (or as the last
// non-DONE frame, depending on provider). Mirrors the JS bridge's
// `stream_options: { include_usage: true }` on every request.
type oaStreamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

// BuildRequest renders the loop's neutral message/tool view into the
// OpenAI Chat Completions JSON body. Per-call opts.Model overrides the
// provider default.
func (p *OpenAIProvider) BuildRequest(messages []Message, tools []Tool, opts RequestOpts) ([]byte, error) {
	model := opts.Model
	if model == "" {
		model = p.Model
	}
	if model == "" {
		return nil, errors.New("openai: no model configured")
	}

	out := oaRequest{
		Model:         model,
		Stream:        true,
		MaxTokens:     opts.MaxTokens,
		StreamOptions: &oaStreamOptions{IncludeUsage: true},
	}

	// System prompt prepended as a synthetic system message (the TS
	// version inlines `effectivePreset` the same way).
	if opts.System != "" {
		out.Messages = append(out.Messages, oaMessage{Role: "system", Content: opts.System})
	}

	for _, m := range messages {
		om := oaMessage{Role: m.Role}
		switch m.Role {
		case "assistant":
			if len(m.ToolCalls) > 0 {
				// Assistant turn that called tools. Content may be the
				// model's pre-tool reasoning; nil is fine if absent.
				if m.Content != "" {
					om.Content = m.Content
				}
				for _, tc := range m.ToolCalls {
					argsBytes, err := json.Marshal(tc.Input)
					if err != nil {
						return nil, fmt.Errorf("openai: marshal tool args for %s: %w", tc.Name, err)
					}
					om.ToolCalls = append(om.ToolCalls, oaToolCall{
						ID:       tc.ID,
						Type:     "function",
						Function: oaToolCallFunc{Name: tc.Name, Arguments: string(argsBytes)},
					})
				}
			} else {
				om.Content = m.Content
			}
		case "tool":
			om.Content = m.Content
			om.ToolCallID = m.ToolCallID
		case "user":
			// Image attachments require the multi-part content array
			// form; plain text uses the simpler string content. Image
			// parts come first so the model sees the visuals before
			// the prompt — same ordering as Anthropic / Node's
			// translation.ts.
			if len(m.ImageBlocks) == 0 {
				om.Content = m.Content
				break
			}
			parts := make([]map[string]any, 0, len(m.ImageBlocks)+1)
			for _, img := range m.ImageBlocks {
				parts = append(parts, map[string]any{
					"type": "image_url",
					"image_url": map[string]any{
						"url": "data:" + img.MediaType + ";base64," + img.Base64,
					},
				})
			}
			if m.Content != "" {
				parts = append(parts, map[string]any{"type": "text", "text": m.Content})
			}
			om.Content = parts
		default:
			om.Content = m.Content
		}
		out.Messages = append(out.Messages, om)
	}

	for _, t := range tools {
		params := t.InputSchema
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out.Tools = append(out.Tools, oaToolDef{
			Type: "function",
			Function: oaToolDefFn{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  params,
			},
		})
	}

	return json.Marshal(out)
}

// ── SSE response parsing ────────────────────────────────────────────────────

// oaStreamFrame is one SSE payload from chat/completions. The `choices`
// array always has a single element in practice (n=1 default). When
// stream_options.include_usage is set, the final non-[DONE] frame
// also carries the cumulative `usage` block; in that frame `choices`
// is typically an empty array.
type oaStreamFrame struct {
	Choices []oaStreamChoice `json:"choices"`
	Error   *oaStreamError   `json:"error,omitempty"`
	Usage   *oaStreamUsage   `json:"usage,omitempty"`
}

// oaStreamUsage is OpenAI's per-request token accounting block. Fields
// mirror the wire shape exactly so we don't have to handle alternate
// names. `PromptTokensDetails.CachedTokens` is the subset of
// `PromptTokens` that came from the prompt cache — we subtract it
// from PromptTokens to compute the NET input, matching the JS
// bridge's convention (so input + cacheRead doesn't double-count).
type oaStreamUsage struct {
	PromptTokens        int                       `json:"prompt_tokens"`
	CompletionTokens    int                       `json:"completion_tokens"`
	TotalTokens         int                       `json:"total_tokens"`
	PromptTokensDetails *oaStreamPromptDetails    `json:"prompt_tokens_details,omitempty"`
}

type oaStreamPromptDetails struct {
	CachedTokens int `json:"cached_tokens"`
}

type oaStreamError struct {
	Message string `json:"message"`
	Code    any    `json:"code,omitempty"`
}

type oaStreamChoice struct {
	Delta        oaStreamDelta `json:"delta"`
	FinishReason string        `json:"finish_reason"`
}

type oaStreamDelta struct {
	Content          string                  `json:"content"`
	ReasoningContent string                  `json:"reasoning_content"`
	ToolCalls        []oaStreamDeltaToolCall `json:"tool_calls"`
}

type oaStreamDeltaToolCall struct {
	Index    int                       `json:"index"`
	ID       string                    `json:"id"`
	Function *oaStreamDeltaToolCallFn `json:"function"`
}

type oaStreamDeltaToolCallFn struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // JSON fragment, accumulates across frames
}

// toolCallAccumulator buffers a single tool call as fragments arrive
// across SSE frames. OpenAI sends id/name on the first chunk and
// streams `arguments` as a string of JSON, possibly split mid-token.
type toolCallAccumulator struct {
	id   string
	name string
	args strings.Builder
}

// Stream parses the SSE response, emitting text deltas as they arrive
// and accumulating any tool calls. Returns the assembled tool calls
// once `finish_reason` fires. `done` is always true on a clean stream
// close — the loop separately checks `len(toolCalls) > 0` to decide
// whether another turn is needed (matches TS behaviour where the for
// loop continues when toolCalls.size > 0).
func (p *OpenAIProvider) Stream(ctx context.Context, body io.Reader, emit EmitFn) ([]ToolUseChunk, bool, error) {
	r := NewEventStreamReader(body)
	accs := map[int]*toolCallAccumulator{}
	var streamErr string

	for {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		ev, err := r.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, false, fmt.Errorf("openai: read SSE: %w", err)
		}
		payload := strings.TrimSpace(ev.Data)
		if payload == "" || payload == "[DONE]" {
			continue
		}

		var frame oaStreamFrame
		if err := json.Unmarshal([]byte(payload), &frame); err != nil {
			// Malformed frame — TS version silently skips. Same here.
			continue
		}

		// Usage frame: fold into the accumulator. Mirrors
		// bridge/tools/stream.ts ~line 253. NET input = prompt minus
		// cached so input + cacheRead doesn't double-count cached
		// tokens (Anthropic's convention).
		if frame.Usage != nil {
			p.addOpenAIUsage(frame.Usage)
		}

		// Provider-embedded errors (OpenRouter sticks them in the body).
		if frame.Error != nil {
			msg := frame.Error.Message
			if msg == "" {
				if b, mErr := json.Marshal(frame.Error); mErr == nil {
					msg = string(b)
				}
			}
			if frame.Error.Code != nil {
				msg = fmt.Sprintf("%s [%v]", msg, frame.Error.Code)
			}
			streamErr = msg
			continue
		}

		if len(frame.Choices) == 0 {
			continue
		}
		choice := frame.Choices[0]

		if choice.Delta.ReasoningContent != "" {
			emit(Chunk{
				Type:      ChunkTypeReasoning,
				Reasoning: choice.Delta.ReasoningContent,
				Provider:  p.Name(),
			})
		}

		if choice.Delta.Content != "" {
			emit(Chunk{
				Type:     ChunkTypeDelta,
				Delta:    choice.Delta.Content,
				Provider: p.Name(),
			})
		}

		for _, tc := range choice.Delta.ToolCalls {
			acc, ok := accs[tc.Index]
			if !ok {
				acc = &toolCallAccumulator{}
				accs[tc.Index] = acc
			}
			if tc.ID != "" {
				acc.id += tc.ID
			}
			if tc.Function != nil {
				if tc.Function.Name != "" {
					acc.name += tc.Function.Name
				}
				if tc.Function.Arguments != "" {
					acc.args.WriteString(tc.Function.Arguments)
				}
			}
		}

		// finish_reason is the spec's signal that this turn is over.
		// We don't break here — drain any final frames for usage etc.
		_ = choice.FinishReason
	}

	// Flush accumulated tool calls into ToolUseChunks. Sort by index
	// so the order matches what the model emitted.
	if len(accs) == 0 {
		if streamErr != "" {
			return nil, false, fmt.Errorf("openai: %s", streamErr)
		}
		return nil, true, nil
	}

	indices := make([]int, 0, len(accs))
	for i := range accs {
		indices = append(indices, i)
	}
	sort.Ints(indices)

	calls := make([]ToolUseChunk, 0, len(indices))
	for _, i := range indices {
		acc := accs[i]
		input := map[string]any{}
		if s := acc.args.String(); s != "" {
			// Parse the accumulated JSON fragment into a map. If the
			// model sent malformed JSON we still surface the call with
			// empty input rather than killing the turn.
			_ = json.Unmarshal([]byte(s), &input)
		}
		tu := ToolUseChunk{
			ID:    acc.id,
			Name:  acc.name,
			Input: input,
		}
		// Emit before appending so BlockAccumulator registers the call
		// and the SSE stream carries the tool name to the frontend —
		// without this, tool-result blocks land with an empty name
		// (only icon + grey text on reload) and live pills show as
		// "orphan:id" because chat-streaming.ts never sees the toolUse.
		emit(Chunk{
			Type:     ChunkTypeToolUse,
			ToolUse:  &tu,
			Provider: p.Name(),
		})
		calls = append(calls, tu)
	}

	// done=true regardless: the per-turn HTTP stream finished. The
	// loop in loop.go inspects len(calls) to decide whether to continue.
	return calls, true, nil
}

// ── UsageProvider ──────────────────────────────────────────────────────────

// Usage returns the running token total accumulated across every turn
// of the current Run loop. Safe to call after Run returns. Reset by
// ResetUsage before each new stream.
func (p *OpenAIProvider) Usage() Usage {
	p.usageMu.Lock()
	defer p.usageMu.Unlock()
	return p.usage
}

// ResetUsage zeroes the accumulator. The route calls this before each
// /v1/stream-direct/ request so a provider reused across sessions
// doesn't leak counts.
func (p *OpenAIProvider) ResetUsage() {
	p.usageMu.Lock()
	defer p.usageMu.Unlock()
	p.usage = Usage{}
}

// addOpenAIUsage folds a parsed usage frame into the running total.
// Sums across turns (the JS bridge does the same: each turn's `chunk.usage`
// is `+=`'d into totals). PromptTokens is treated as GROSS — we
// subtract cached to get NET input.
func (p *OpenAIProvider) addOpenAIUsage(u *oaStreamUsage) {
	if u == nil {
		return
	}
	cached := 0
	if u.PromptTokensDetails != nil {
		cached = u.PromptTokensDetails.CachedTokens
	}
	net := u.PromptTokens - cached
	if net < 0 {
		net = 0
	}
	p.usageMu.Lock()
	defer p.usageMu.Unlock()
	p.usage.InputTokens += net
	p.usage.OutputTokens += u.CompletionTokens
	p.usage.CacheReadTokens += cached
}
