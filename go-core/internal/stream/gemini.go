package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

// GeminiProvider is the Provider implementation for Google's
// generative-language API (`generativelanguage.googleapis.com`),
// streaming via `:streamGenerateContent?alt=sse`.
//
// Wire-shape note: Gemini's API is NOT OpenAI-compatible:
//
//   - Top-level field is `contents` (not `messages`).
//   - Each entry has role ∈ {"user", "model"} and a `parts` array of
//     `{text}` | `{functionCall}` | `{functionResponse}` | `{inlineData}`.
//   - System messages live at top-level `systemInstruction`, not in
//     `contents`.
//   - Tools are nested: `tools: [{functionDeclarations: [...]}]`.
//   - `functionCall` parts have NO id field — we synthesise one at
//     parse time so the loop can pair tool_use with tool_result.
//
// See bridge/tools/stream.ts streamDirectGemini (~lines 376-521) for
// the JS reference implementation this was ported from.
type GeminiProvider struct {
	// BaseURL is the API origin. Defaults to
	// "https://generativelanguage.googleapis.com" if blank.
	BaseURL string

	// Model is the model id used to construct the per-call URL
	// (e.g. "gemini-2.5-flash"). Set this once at provider init OR
	// let BuildRequest stash opts.Model here for you (see below).
	Model string

	// turn is incremented every time BuildRequest is called, so
	// per-turn synthesised tool-call ids stay unique across the
	// whole conversation.
	turn int

	// usage holds the latest token total surfaced by Gemini's
	// usageMetadata. Gemini reports cumulative-context counts on
	// every chunk, so within and across turns we just overwrite —
	// the final reading on the last turn IS the full-conversation
	// total. Mirrors bridge/tools/stream.ts ~line 446
	// (`totalInputTokens = chunk.usageMetadata.promptTokenCount`).
	usage Usage

	mu sync.Mutex
}

const defaultGeminiBaseURL = "https://generativelanguage.googleapis.com"

// Name implements Provider.
func (p *GeminiProvider) Name() string { return "gemini" }

// Endpoint implements Provider.
//
// Gemini's URL is per-model:
//
//	${BaseURL}/v1beta/models/${model}:streamGenerateContent?alt=sse
//
// The Provider interface doesn't pass opts to Endpoint(), so we read
// p.Model. Callers MUST set p.Model before constructing the Run
// loop, OR call BuildRequest first (which stashes opts.Model on the
// receiver as a fallback).
func (p *GeminiProvider) Endpoint() string {
	base := strings.TrimRight(p.BaseURL, "/")
	if base == "" {
		base = defaultGeminiBaseURL
	}
	model := p.Model
	if model == "" {
		// Last-resort placeholder — keeps the URL well-formed so the
		// downstream HTTP error is informative rather than panicking.
		model = "MODEL_NOT_SET"
	}
	return fmt.Sprintf("%s/v1beta/models/%s:streamGenerateContent?alt=sse", base, model)
}

// Headers implements Provider.
//
// Gemini auth uses the `x-goog-api-key` header (not Authorization).
// SSE response requires Accept: text/event-stream — without it the
// API silently returns the non-streaming JSON-array shape.
func (p *GeminiProvider) Headers(apiKey string) http.Header {
	h := http.Header{}
	if apiKey != "" {
		h.Set("x-goog-api-key", apiKey)
	}
	h.Set("Content-Type", "application/json")
	h.Set("Accept", "text/event-stream")
	return h
}

// ── Request body shape ─────────────────────────────────────────────────────

type geminiPart struct {
	Text             string                  `json:"text,omitempty"`
	InlineData       *geminiInlineData       `json:"inlineData,omitempty"`
	FunctionCall     *geminiFunctionCall     `json:"functionCall,omitempty"`
	FunctionResponse *geminiFunctionResponse `json:"functionResponse,omitempty"`
	// thoughtSignature appears at the part level alongside functionCall
	// (not nested inside it). Required for Gemini thinking models on
	// follow-up turns that include prior tool calls.
	ThoughtSignature string `json:"thoughtSignature,omitempty"`
}

// geminiInlineData carries a base64-encoded image attachment as an
// inline part of the user message. Mirrors Google's generativelanguage
// API "inline_data" / "inlineData" field (the v1 API spec accepts both
// camelCase forms; we use the JS-style camelCase to match the rest of
// the request body).
type geminiInlineData struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type geminiFunctionCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args,omitempty"`
}

type geminiFunctionResponse struct {
	Name     string         `json:"name"`
	Response map[string]any `json:"response"`
}

type geminiContent struct {
	Role  string       `json:"role"`
	Parts []geminiPart `json:"parts"`
}

type geminiSystemInstruction struct {
	Parts []geminiPart `json:"parts"`
}

type geminiFunctionDeclaration struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type geminiToolBlock struct {
	FunctionDeclarations []geminiFunctionDeclaration `json:"functionDeclarations"`
}

// toolConfig lets us force mode=NONE when the user has disabled tools
// for this turn (caps.tools=false). Without it, some Gemini variants
// (gemini-3.5-flash etc) still emit functionCall parts even when the
// tools array is absent, because the system prompt mentions Glob/Read.
type geminiToolConfig struct {
	FunctionCallingConfig *geminiFunctionCallingConfig `json:"functionCallingConfig,omitempty"`
}
type geminiFunctionCallingConfig struct {
	Mode string `json:"mode,omitempty"` // AUTO | ANY | NONE
}

type geminiRequest struct {
	Contents          []geminiContent          `json:"contents"`
	SystemInstruction *geminiSystemInstruction `json:"systemInstruction,omitempty"`
	Tools             []geminiToolBlock        `json:"tools,omitempty"`
	ToolConfig        *geminiToolConfig        `json:"toolConfig,omitempty"`
	GenerationConfig  map[string]any           `json:"generationConfig,omitempty"`
}

// BuildRequest implements Provider.
//
// Mapping rules:
//
//   - role=system → top-level systemInstruction (NOT in contents).
//   - role=user → contents entry with role="user", parts=[{text}].
//   - role=assistant → contents entry with role="model".
//     If ToolCalls is non-empty, each becomes a {functionCall} part.
//   - role=tool → contents entry with role="user" (Gemini's quirk —
//     tool results are user-side), parts=[{functionResponse}].
func (p *GeminiProvider) BuildRequest(messages []Message, tools []Tool, opts RequestOpts) ([]byte, error) {
	// Stash model on the receiver so Endpoint() (which has no opts)
	// can pick it up. This makes the provider usable even if the
	// caller forgets to set p.Model before construction.
	p.mu.Lock()
	if opts.Model != "" {
		p.Model = opts.Model
	}
	p.turn++
	p.mu.Unlock()

	req := geminiRequest{}

	// Effective system text: explicit opts.System wins; otherwise we
	// concatenate any role=system messages.
	systemText := opts.System
	if systemText == "" {
		var parts []string
		for _, m := range messages {
			if m.Role == "system" && m.Content != "" {
				parts = append(parts, m.Content)
			}
		}
		systemText = strings.Join(parts, "\n\n")
	}
	if systemText != "" {
		req.SystemInstruction = &geminiSystemInstruction{
			Parts: []geminiPart{{Text: systemText}},
		}
	}

	for _, m := range messages {
		switch m.Role {
		case "system":
			// Already folded into SystemInstruction above.
			continue

		case "user":
			parts := make([]geminiPart, 0, len(m.ImageBlocks)+1)
			// Images first so the model sees the visuals before the
			// prompt, matching Anthropic/OpenAI ordering.
			for _, img := range m.ImageBlocks {
				parts = append(parts, geminiPart{
					InlineData: &geminiInlineData{
						MimeType: img.MediaType,
						Data:     img.Base64,
					},
				})
			}
			if m.Content != "" {
				parts = append(parts, geminiPart{Text: m.Content})
			}
			if len(parts) == 0 {
				continue
			}
			req.Contents = append(req.Contents, geminiContent{
				Role:  "user",
				Parts: parts,
			})

		case "assistant":
			parts := []geminiPart{}
			if m.Content != "" {
				parts = append(parts, geminiPart{Text: m.Content})
			}
			for _, tc := range m.ToolCalls {
				p := geminiPart{
					FunctionCall: &geminiFunctionCall{
						Name: tc.Name,
						Args: tc.Input,
					},
				}
				if tc.ThoughtSignature != "" {
					p.ThoughtSignature = tc.ThoughtSignature
				}
				parts = append(parts, p)
			}
			if len(parts) == 0 {
				// Skip empty assistant turns — Gemini rejects role
				// entries with no parts.
				continue
			}
			req.Contents = append(req.Contents, geminiContent{
				Role:  "model",
				Parts: parts,
			})

		case "tool":
			// Tool results belong on the user side in Gemini's model.
			// We need the function name to attach the response to;
			// derive it from the call-id prefix `${name}#${...}` if
			// present, else fall back to the literal id.
			name := m.ToolCallID
			if hash := strings.IndexByte(name, '#'); hash > 0 {
				name = name[:hash]
			}
			req.Contents = append(req.Contents, geminiContent{
				Role: "user",
				Parts: []geminiPart{{
					FunctionResponse: &geminiFunctionResponse{
						Name: name,
						Response: map[string]any{
							"result": m.Content,
						},
					},
				}},
			})

		default:
			// Unknown role — skip rather than crash.
		}
	}

	if len(tools) > 0 {
		decls := make([]geminiFunctionDeclaration, 0, len(tools))
		for _, t := range tools {
			decls = append(decls, geminiFunctionDeclaration{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.InputSchema,
			})
		}
		req.Tools = []geminiToolBlock{{FunctionDeclarations: decls}}
	} else {
		// Force no function calling. Prevents eager models from emitting
		// Glob/Read/etc calls (and then hanging in the tool loop) when the
		// user has toggled tools off via the cap badge.
		req.ToolConfig = &geminiToolConfig{
			FunctionCallingConfig: &geminiFunctionCallingConfig{Mode: "NONE"},
		}
	}

	if opts.MaxTokens > 0 {
		req.GenerationConfig = map[string]any{
			"maxOutputTokens": opts.MaxTokens,
		}
	}

	return json.Marshal(req)
}

// ── Response (SSE) shape ───────────────────────────────────────────────────

type geminiSSEChunk struct {
	Candidates []struct {
		Content struct {
			Parts []geminiPart `json:"parts"`
			Role  string       `json:"role"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata *geminiUsageMetadata `json:"usageMetadata,omitempty"`
}

// geminiUsageMetadata mirrors Gemini's per-chunk usage block. Counts
// are CUMULATIVE for the whole conversation — Gemini re-emits the
// latest running total on every chunk, so the parser overwrites
// rather than summing.
type geminiUsageMetadata struct {
	PromptTokenCount        int `json:"promptTokenCount"`
	CandidatesTokenCount    int `json:"candidatesTokenCount"`
	CachedContentTokenCount int `json:"cachedContentTokenCount"`
}

// Stream implements Provider.
//
// Each SSE frame's `data:` payload is a JSON object of the shape
// described by geminiSSEChunk. We walk parts in order, emitting deltas
// for text and accumulating tool calls for functionCall.
//
// Tool-call ids: Gemini doesn't provide one, so we synthesise
// "${name}#${turn}.${callIdx}" — the same scheme the JS bridge uses
// (see bridge/tools/stream.ts ~line 477). turn is incremented per
// BuildRequest; callIdx counts within this Stream invocation.
//
// Stream signals "done" when finishReason is one of STOP, TOOL_USE,
// MAX_TOKENS, or when the SSE body closes cleanly with no more frames.
func (p *GeminiProvider) Stream(ctx context.Context, body io.Reader, emit EmitFn) ([]ToolUseChunk, bool, error) {
	if emit == nil {
		emit = func(Chunk) {}
	}

	p.mu.Lock()
	turnIdx := p.turn - 1
	if turnIdx < 0 {
		turnIdx = 0
	}
	p.mu.Unlock()

	reader := NewEventStreamReader(body)
	var toolCalls []ToolUseChunk
	callIdx := 0
	done := false

	for {
		if err := ctx.Err(); err != nil {
			return toolCalls, false, err
		}

		ev, err := reader.Next()
		if errors.Is(err, io.EOF) {
			// Stream closed without an explicit STOP — treat as done
			// if we got any content; the loop will decide whether to
			// continue based on toolCalls.
			done = true
			break
		}
		if err != nil {
			return toolCalls, false, err
		}
		if ev.Data == "" {
			continue
		}

		var chunk geminiSSEChunk
		if err := json.Unmarshal([]byte(ev.Data), &chunk); err != nil {
			// Malformed frame — skip rather than abort the whole
			// stream. Mirrors the JS bridge's permissive behaviour.
			continue
		}

		// usageMetadata arrives on every chunk in Gemini's stream
		// and carries the running cumulative-context totals (NOT
		// the per-chunk delta). Overwrite — last reading wins.
		if chunk.UsageMetadata != nil {
			p.setGeminiUsage(chunk.UsageMetadata)
		}

		for _, cand := range chunk.Candidates {
			for _, part := range cand.Content.Parts {
				if part.Text != "" {
					emit(Chunk{
						Type:     ChunkTypeDelta,
						Delta:    part.Text,
						Provider: p.Name(),
					})
				}
				if part.FunctionCall != nil {
					synthID := fmt.Sprintf("%s#%d.%d", part.FunctionCall.Name, turnIdx, callIdx)
					callIdx++
					tc := ToolUseChunk{
						ID:               synthID,
						Name:             part.FunctionCall.Name,
						Input:            part.FunctionCall.Args,
						ThoughtSignature: part.ThoughtSignature,
					}
					if tc.Input == nil {
						tc.Input = map[string]any{}
					}
					toolCalls = append(toolCalls, tc)
					emit(Chunk{
						Type:     ChunkTypeToolUse,
						ToolUse:  &tc,
						Provider: p.Name(),
					})
				}
			}

			switch cand.FinishReason {
			case "STOP", "MAX_TOKENS", "TOOL_USE", "FINISH_REASON_STOP":
				done = true
			}
		}

		if done {
			break
		}
	}

	return toolCalls, done, nil
}

// ── UsageProvider ──────────────────────────────────────────────────────────

// Usage returns the latest cumulative token totals reported by
// Gemini's usageMetadata. Safe to call after Run returns.
func (p *GeminiProvider) Usage() Usage {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.usage
}

// ResetUsage zeroes the accumulator. The route calls this before each
// /v1/stream-direct/ request.
func (p *GeminiProvider) ResetUsage() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.usage = Usage{}
}

// setGeminiUsage overwrites the running totals with the latest
// reading. Gemini reports cumulative-context counts on every chunk,
// so last-write semantics correctly capture the full conversation's
// token usage. Cached content count maps to CacheReadTokens —
// Gemini doesn't expose a cache-creation breakdown so that field
// stays zero.
func (p *GeminiProvider) setGeminiUsage(u *geminiUsageMetadata) {
	if u == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if u.PromptTokenCount > 0 {
		p.usage.InputTokens = u.PromptTokenCount
	}
	if u.CandidatesTokenCount > 0 {
		p.usage.OutputTokens = u.CandidatesTokenCount
	}
	if u.CachedContentTokenCount > 0 {
		p.usage.CacheReadTokens = u.CachedContentTokenCount
	}
}
