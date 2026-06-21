package stream

import (
	"bytes"
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

// AnthropicProvider implements Provider for the Anthropic Messages API
// (api.anthropic.com/v1/messages). Mirrors streamDirectAnthropic in
// bridge/tools/stream.ts.
//
// Anthropic differs from OpenAI/Gemini in three important ways:
//
//  1. The system prompt is a top-level field, NOT a message with
//     role=system. BuildRequest extracts role=system entries and uses
//     opts.System as a fallback.
//  2. Tool results are not their own role. A role=tool message becomes
//     a role=user message whose content is `[{type: "tool_result", …}]`.
//  3. The streaming wire format is block-based: content_block_start /
//     content_block_delta / content_block_stop frames bracket each
//     output block (text | thinking | tool_use). Tool_use input arrives
//     as a stream of partial JSON strings that must be reassembled and
//     parsed at content_block_stop.
type AnthropicProvider struct {
	BaseURL string // default "https://api.anthropic.com"
	Model   string

	// usage accumulates token counts across every turn of a single
	// Run loop. Anthropic surfaces input + cache breakdown on
	// message_start and output on message_delta. The mutex guards
	// concurrent reads from the route (after Run) and writes from
	// Stream (during Run) — in practice they don't overlap, but the
	// race detector demands the guarantee anyway.
	//
	// _lastTurnOutput tracks the running OutputTokens total as of
	// the start of the current turn so message_delta's last-write
	// semantics (within a turn) translate to additive semantics
	// (across turns).
	usage           Usage
	_lastTurnOutput int
	usageMu         sync.Mutex
}

// Name returns the canonical provider tag surfaced on chunks.
func (p *AnthropicProvider) Name() string { return "anthropic" }

// Endpoint returns the full Messages API URL. BaseURL may be overridden
// for tests / proxies; if blank, the public Anthropic host is used.
// Trailing /v1 (or /v1/) on BaseURL is tolerated for parity with the TS
// bridge code.
func (p *AnthropicProvider) Endpoint() string {
	base := p.BaseURL
	if base == "" {
		base = "https://api.anthropic.com"
	}
	base = strings.TrimRight(base, "/")
	base = strings.TrimSuffix(base, "/v1")
	base = strings.TrimRight(base, "/")
	return base + "/v1/messages"
}

// Headers returns the Anthropic-specific auth + version headers. Note:
// Anthropic uses x-api-key (NOT Authorization: Bearer …).
func (p *AnthropicProvider) Headers(apiKey string) http.Header {
	h := http.Header{}
	h.Set("x-api-key", apiKey)
	h.Set("anthropic-version", "2023-06-01")
	h.Set("Content-Type", "application/json")
	h.Set("Accept", "text/event-stream")
	return h
}

// effortBudget maps the abstract Effort knob (low/medium/high/xhigh/max)
// to Anthropic's thinking.budget_tokens. Mirrors EFFORT_BUDGET in
// stream.ts. Unknown values fall through to the default 8000.
func effortBudget(effort string) int {
	switch strings.ToLower(effort) {
	case "low":
		return 2000
	case "medium":
		return 5000
	case "high":
		return 10000
	case "xhigh", "x-high":
		return 16000
	case "max":
		return 32000
	default:
		return 8000
	}
}

// anthropicRequest is the on-wire request shape. Only fields with
// values are emitted thanks to omitempty.
type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	Stream    bool               `json:"stream"`
	System    string             `json:"system,omitempty"`
	Messages  []anthropicMessage `json:"messages"`
	Tools     []anthropicTool    `json:"tools,omitempty"`
	Thinking  *anthropicThinking `json:"thinking,omitempty"`
}

type anthropicThinking struct {
	Type         string `json:"type"`
	BudgetTokens int    `json:"budget_tokens"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // string or []anthropicContentBlock
}

type anthropicContentBlock struct {
	Type string `json:"type"`
	// text block
	Text string `json:"text,omitempty"`
	// tool_use block
	ID    string         `json:"id,omitempty"`
	Name  string         `json:"name,omitempty"`
	Input map[string]any `json:"input,omitempty"`
	// tool_result block (lives inside a role=user message)
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content   string `json:"content,omitempty"`
	// image block (lives inside a role=user message)
	Source *anthropicImageSource `json:"source,omitempty"`
}

type anthropicImageSource struct {
	Type      string `json:"type"`       // "base64"
	MediaType string `json:"media_type"` // "image/png" etc.
	Data      string `json:"data"`       // base64-encoded image bytes
}

type anthropicTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"input_schema"`
}

// BuildRequest renders messages + tools + opts into the Anthropic
// Messages API request body. See the type docstring for the rules.
func (p *AnthropicProvider) BuildRequest(messages []Message, tools []Tool, opts RequestOpts) ([]byte, error) {
	model := opts.Model
	if model == "" {
		model = p.Model
	}
	if model == "" {
		return nil, errors.New("anthropic: no model configured (opts.Model and provider.Model both empty)")
	}

	maxTokens := opts.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 4096
	}

	// Extract any role=system messages into the top-level field.
	// opts.System wins if both are present (caller-explicit beats history).
	system := opts.System
	out := make([]anthropicMessage, 0, len(messages))
	for _, m := range messages {
		if m.Role == "system" {
			if system == "" {
				system = m.Content
			} else if m.Content != "" {
				system = system + "\n\n" + m.Content
			}
			continue
		}
		converted, err := convertMessageToAnthropic(m)
		if err != nil {
			return nil, err
		}
		out = append(out, converted)
	}

	req := anthropicRequest{
		Model:     model,
		MaxTokens: maxTokens,
		Stream:    true,
		System:    system,
		Messages:  out,
	}

	if len(tools) > 0 {
		req.Tools = make([]anthropicTool, 0, len(tools))
		for _, t := range tools {
			req.Tools = append(req.Tools, anthropicTool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.InputSchema,
			})
		}
	}

	// Enable Anthropic `thinking` when EITHER the FE shipped a
	// reasoning effort knob OR the FE-level caps.reasoning="enabled"
	// toggle is on. Mirrors Node tools/stream.ts:545-548 — the
	// reasoning toggle alone (without an effort) opens up a default-
	// budget thinking pass; both fields together let the operator
	// tune budget. Reasoning="disabled" suppresses thinking even when
	// an effort is present.
	wantThinking := opts.Effort != "" || strings.EqualFold(opts.Reasoning, "enabled")
	if strings.EqualFold(opts.Reasoning, "disabled") {
		wantThinking = false
	}
	if wantThinking {
		budget := effortBudget(opts.Effort)
		if budget <= 0 {
			budget = effortBudget("medium")
		}
		req.Thinking = &anthropicThinking{
			Type:         "enabled",
			BudgetTokens: budget,
		}
	}

	return json.Marshal(req)
}

// convertMessageToAnthropic translates one neutral Message to Anthropic
// shape. The only non-trivial cases are role=tool (becomes user with a
// tool_result block) and role=assistant with ToolCalls (becomes a
// content array with tool_use blocks).
func convertMessageToAnthropic(m Message) (anthropicMessage, error) {
	switch m.Role {
	case "user":
		// Plain-text user message → string content; image attachments
		// require the multi-block array form. Image blocks come first
		// so the model sees the visuals before the prompt, matching
		// pre-refactor Node's translation.ts ordering.
		if len(m.ImageBlocks) == 0 {
			return anthropicMessage{Role: "user", Content: m.Content}, nil
		}
		blocks := make([]anthropicContentBlock, 0, len(m.ImageBlocks)+1)
		for _, img := range m.ImageBlocks {
			blocks = append(blocks, anthropicContentBlock{
				Type: "image",
				Source: &anthropicImageSource{
					Type:      "base64",
					MediaType: img.MediaType,
					Data:      img.Base64,
				},
			})
		}
		if m.Content != "" {
			blocks = append(blocks, anthropicContentBlock{Type: "text", Text: m.Content})
		}
		return anthropicMessage{Role: "user", Content: blocks}, nil

	case "tool":
		// role=tool → role=user with a tool_result content block.
		return anthropicMessage{
			Role: "user",
			Content: []anthropicContentBlock{{
				Type:      "tool_result",
				ToolUseID: m.ToolCallID,
				Content:   m.Content,
			}},
		}, nil

	case "assistant":
		// Plain text assistant: pass content through as a string.
		if len(m.ToolCalls) == 0 {
			return anthropicMessage{Role: "assistant", Content: m.Content}, nil
		}
		// Assistant turn with tool calls: build a content array of
		// [optional text block, …tool_use blocks].
		blocks := make([]anthropicContentBlock, 0, 1+len(m.ToolCalls))
		if m.Content != "" {
			blocks = append(blocks, anthropicContentBlock{Type: "text", Text: m.Content})
		}
		for _, tc := range m.ToolCalls {
			input := tc.Input
			if input == nil {
				input = map[string]any{}
			}
			blocks = append(blocks, anthropicContentBlock{
				Type:  "tool_use",
				ID:    tc.ID,
				Name:  tc.Name,
				Input: input,
			})
		}
		return anthropicMessage{Role: "assistant", Content: blocks}, nil

	default:
		// Unknown roles get treated as user (defensive — the loop only
		// produces user/assistant/tool/system).
		return anthropicMessage{Role: "user", Content: m.Content}, nil
	}
}

// ── Streaming ─────────────────────────────────────────────────────────

// anthropicBlock tracks an in-flight content block while we're still
// receiving deltas for it. Closed at content_block_stop.
type anthropicBlock struct {
	blockType string // "text" | "thinking" | "tool_use"
	id        string
	name      string
	textBuf   bytes.Buffer // text or thinking content
	inputBuf  bytes.Buffer // accumulated partial_json for tool_use
	signature strings.Builder
}

// Stream consumes the Anthropic SSE response and emits Chunks. Returns
// the completed tool_use blocks (in stream order), whether the
// conversation reached a stopping point, and any error.
//
// Anthropic's stream is block-based: each output block (text /
// thinking / tool_use) is bracketed by content_block_start and
// content_block_stop, with content_block_delta carrying the actual
// payload. We track blocks by index (the integer in each event's
// `index` field) rather than relying on order, since interleaved
// deltas across blocks are theoretically possible.
func (p *AnthropicProvider) Stream(
	ctx context.Context,
	body io.Reader,
	emit EmitFn,
) ([]ToolUseChunk, bool, error) {
	if emit == nil {
		emit = func(Chunk) {}
	}
	reader := NewEventStreamReader(body)

	blocks := make(map[int]*anthropicBlock)
	// completedTools preserves stream-order tool_use blocks for the
	// loop's next turn. Map index → finalised ToolUseChunk; we sort by
	// index at the end so out-of-order content_block_stop events still
	// produce a deterministic order.
	type indexedTool struct {
		index int
		tu    ToolUseChunk
	}
	var completedTools []indexedTool

	stopReason := ""
	done := false

	for {
		// Cancellation check between frames keeps the stream responsive
		// without slamming ctx.Err on every byte.
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}

		ev, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, false, fmt.Errorf("anthropic: read sse: %w", err)
		}
		if strings.TrimSpace(ev.Data) == "" {
			continue
		}

		var raw map[string]any
		if err := json.Unmarshal([]byte(ev.Data), &raw); err != nil {
			// Malformed JSON in a data line — surface as an error so
			// the caller can decide. The Anthropic API doesn't send
			// these in practice; if it does, something is broken.
			return nil, false, fmt.Errorf("anthropic: parse event %q: %w", ev.Data, err)
		}

		typ, _ := raw["type"].(string)
		// The `event:` line is informational; the source of truth is
		// the `type` field in the data JSON. (TS bridge ignores `ev.Name`
		// for the same reason.)
		switch typ {
		case "message_start":
			// Anthropic packs input + cache breakdown into
			// message.usage. Output_tokens is populated here too
			// (with a placeholder value) and then refined via
			// message_delta as the stream progresses — we take the
			// last-seen output_tokens to mirror the JS bridge.
			if msg, ok := raw["message"].(map[string]any); ok {
				if u, ok := msg["usage"].(map[string]any); ok {
					p.addAnthropicUsage(u, false)
				}
			}

		case "content_block_start":
			idx := intField(raw, "index")
			cb, _ := raw["content_block"].(map[string]any)
			b := &anthropicBlock{}
			if cb != nil {
				b.blockType, _ = cb["type"].(string)
				b.id, _ = cb["id"].(string)
				b.name, _ = cb["name"].(string)
			}
			blocks[idx] = b

		case "content_block_delta":
			idx := intField(raw, "index")
			b := blocks[idx]
			if b == nil {
				// Defensive: stream sent a delta for an unknown block.
				continue
			}
			d, _ := raw["delta"].(map[string]any)
			if d == nil {
				continue
			}
			dtype, _ := d["type"].(string)
			switch dtype {
			case "text_delta":
				text, _ := d["text"].(string)
				b.textBuf.WriteString(text)
				emit(Chunk{
					Type:     ChunkTypeDelta,
					Delta:    text,
					Provider: p.Name(),
				})
			case "thinking_delta":
				think, _ := d["thinking"].(string)
				b.textBuf.WriteString(think)
				emit(Chunk{
					Type:      ChunkTypeReasoning,
					Reasoning: think,
					Provider:  p.Name(),
				})
			case "input_json_delta":
				// tool_use input arrives as a stream of JSON
				// fragments. We just concat; it's parsed at
				// content_block_stop.
				partial, _ := d["partial_json"].(string)
				b.inputBuf.WriteString(partial)
			case "signature_delta":
				// Anthropic uses signatures to verify thinking blocks
				// can be replayed across turns. We accumulate but
				// don't surface them — the loop's history doesn't
				// preserve thinking blocks today.
				sig, _ := d["signature"].(string)
				b.signature.WriteString(sig)
			}

		case "content_block_stop":
			idx := intField(raw, "index")
			b := blocks[idx]
			if b == nil {
				continue
			}
			if b.blockType == "tool_use" {
				input := map[string]any{}
				rawJSON := strings.TrimSpace(b.inputBuf.String())
				if rawJSON == "" {
					rawJSON = "{}"
				}
				if err := json.Unmarshal([]byte(rawJSON), &input); err != nil {
					// Treat as empty rather than failing the whole
					// turn — the model occasionally emits malformed
					// JSON when it bails mid-call.
					input = map[string]any{}
				}
				tu := ToolUseChunk{ID: b.id, Name: b.name, Input: input}
				completedTools = append(completedTools, indexedTool{index: idx, tu: tu})
				emit(Chunk{
					Type:     ChunkTypeToolUse,
					ToolUse:  &tu,
					Provider: p.Name(),
				})
			}
			// Free the block — no further events should arrive for it.
			delete(blocks, idx)

		case "message_delta":
			d, _ := raw["delta"].(map[string]any)
			if d != nil {
				if sr, ok := d["stop_reason"].(string); ok && sr != "" {
					stopReason = sr
				}
			}
			// message_delta carries the running output_tokens count.
			// We use last-write semantics: the final delta on this
			// turn has the true output total. Anthropic does NOT
			// re-emit input / cache numbers here, so they stay locked
			// in from message_start.
			if u, ok := raw["usage"].(map[string]any); ok {
				p.addAnthropicUsage(u, true)
			}

		case "message_stop":
			done = true

		case "error":
			// Anthropic in-stream error — surface and bail.
			errObj, _ := raw["error"].(map[string]any)
			msg := "anthropic stream error"
			if errObj != nil {
				if m, ok := errObj["message"].(string); ok && m != "" {
					msg = "anthropic: " + m
				} else if t, ok := errObj["type"].(string); ok && t != "" {
					msg = "anthropic: " + t
				}
			}
			return nil, false, errors.New(msg)
		}
	}

	// Sort completed tools by stream index for deterministic ordering.
	sort.SliceStable(completedTools, func(i, j int) bool {
		return completedTools[i].index < completedTools[j].index
	})
	out := make([]ToolUseChunk, 0, len(completedTools))
	for _, it := range completedTools {
		out = append(out, it.tu)
	}

	// We always report `done=true` once the upstream stream closes:
	// Anthropic streams end with message_stop on success, or close
	// abruptly on transport failure (already returned above). The loop
	// uses the toolCalls list to decide whether to spin another turn.
	_ = stopReason
	if !done {
		// Stream ended without explicit message_stop. That's only
		// "done" in the loop's eyes if we have no tool calls — but
		// either way the upstream closed, so we say done. The loop
		// branches on len(toolCalls) for the actual decision.
		done = true
	}
	return out, done, nil
}

// intField pulls an int out of a JSON-decoded map. JSON numbers come
// back as float64, so we accept that too.
func intField(m map[string]any, key string) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		i, _ := v.Int64()
		return int(i)
	default:
		return 0
	}
}

// ── UsageProvider ──────────────────────────────────────────────────────────

// Usage returns the running token total accumulated across every turn
// of the current Run loop. Safe to call after Run returns. Reset by
// ResetUsage before each new stream.
func (p *AnthropicProvider) Usage() Usage {
	p.usageMu.Lock()
	defer p.usageMu.Unlock()
	return p.usage
}

// ResetUsage zeroes the accumulator. Routes call this immediately
// before a fresh /v1/stream-direct/ request so a provider value reused
// across sessions doesn't leak counts.
func (p *AnthropicProvider) ResetUsage() {
	p.usageMu.Lock()
	defer p.usageMu.Unlock()
	p.usage = Usage{}
	p._lastTurnOutput = 0
}

// addAnthropicUsage folds a parsed `usage` map into the running total.
//
// fromDelta=true means the data came from a message_delta frame, where
// output_tokens uses last-write semantics within a single turn — the
// final delta has the true count. Across turns we sum (the loop calls
// Stream again, message_start re-seeds output_tokens for the new turn).
//
// fromDelta=false means message_start, where the input_tokens +
// cache_* numbers are authoritative for the turn (Anthropic does not
// re-emit them on subsequent frames).
//
// Mirrors bridge/tools/stream.ts ~line 631 / ~line 682.
func (p *AnthropicProvider) addAnthropicUsage(u map[string]any, fromDelta bool) {
	p.usageMu.Lock()
	defer p.usageMu.Unlock()
	if fromDelta {
		// message_delta: only output_tokens is fresh. We track the
		// last-seen value for this turn in a sidecar so multiple
		// deltas within a turn don't double-count. Implementation
		// detail: we keep the prior turn's output total and add the
		// per-turn last-seen at message_stop time. Simpler approach:
		// subtract the previous turn's contribution before adding
		// the latest. We use a separate per-turn buffer to make the
		// math obvious — see turnOutputTokens below.
		newOut := intField(u, "output_tokens")
		// Last-write within a turn: replace the running per-turn
		// contribution. Since p.usage.OutputTokens already includes
		// the previous (now stale) reading for this turn, we adjust
		// by the delta. _lastTurnOutput tracks the prior turn's
		// final value so we know how much of p.usage.OutputTokens
		// belongs to closed-out turns.
		p.usage.OutputTokens = p._lastTurnOutput + newOut
		return
	}
	// message_start: input + cache numbers are summed across turns
	// (per the JS bridge's behaviour — totalInputTokens += each turn).
	p.usage.InputTokens += intField(u, "input_tokens")
	p.usage.CacheCreationTokens += intField(u, "cache_creation_input_tokens")
	p.usage.CacheReadTokens += intField(u, "cache_read_input_tokens")
	// Close out the previous turn's output contribution: at this
	// point p.usage.OutputTokens reflects the prior turn's final
	// value. Lock it in as the new baseline so the next message_delta
	// in this turn replaces the per-turn portion correctly.
	p._lastTurnOutput = p.usage.OutputTokens
}
