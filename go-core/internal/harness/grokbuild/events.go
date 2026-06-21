package grokbuild

// events.go — grok JSON-Lines event decoding.
//
// Handles the full current headless streaming-json catalog (session.*,
// model.thinking, tool.call / tool.result, model.message, end) plus
// legacy (thought/text/end) for forward+backward compat (per
// https://docs.x.ai/build/cli/headless-scripting and observed 2026 CLI).
// Tool events are mapped to stream.ChunkTypeToolUse / ToolResult and
// thinking to ChunkTypeReasoning so blocks.go, rewind, and FE render
// grok turns with the same cards/collapsibles as claude-binary / codex.
// Unknown events are skipped (safe default; see Part 11/12 of the review).

import (
	"encoding/json"
	"strings"
)

// grokEvent is the observed wire shape (grok 0.2.x legacy + 2026+
// streaming-json with rich agent events). Fields kept generous so a
// CLI bump can add keys without breaking decode. Unknown keys dropped.
type grokEvent struct {
	Type       string `json:"type"`
	Data       any    `json:"data"`
	StopReason string `json:"stopReason"`
	SessionID  string `json:"sessionId"`
	RequestID  string `json:"requestId"`
	Message    string `json:"message"`
	Error      string `json:"error"`

	// Rich/agentic event fields (tool.call, tool.result, usage on end etc).
	// Populated from top-level or via Data fallback in parse.
	ID           string `json:"id"`
	Tool         string `json:"tool"`
	Args         any    `json:"args"`
	Content      any    `json:"content"`
	InputTokens  int64  `json:"input_tokens"`
	OutputTokens int64  `json:"output_tokens"`
	// camelCase aliases some builds / future may use
	InputTokens2  int64 `json:"inputTokens"`
	OutputTokens2 int64 `json:"outputTokens"`
	// Model name if the CLI reports the resolved/used one (on session.start,
	// session.end, or a sibling event). Lets the final meta bar show the
	// precise model for grok turns when the CLI surfaces it.
	Model string `json:"model"`
}

type parsed struct {
	kind       lineKind
	delta      string
	stopReason string
	sessionID  string
	errMsg     string

	// tool.* for ChunkTypeToolUse / ToolResult
	toolID   string
	toolName string
	toolArgs any

	resultID      string
	resultContent string

	// usage captured from end / usage events (passed through to runResult
	// so Result.Usage is non-zero when the grok CLI surfaces numbers)
	inputTokens  int64
	outputTokens int64

	// model reported by CLI (for final meta bar when more specific than req)
	model string
}

type lineKind int

const (
	lineSkip lineKind = iota
	lineDelta
	lineReasoning
	lineEnd
	lineErr
	lineToolUse
	lineToolResult
)

// parseLine decodes one stdout line into a parsed verdict. Non-JSON
// lines fall through to lineDelta so the user sees something rather
// than a silent hang (matches the codex fallback).
//
// Supports both legacy wire (thought/text/end) and current grok
// headless streaming-json (model.thinking / tool.call / tool.result /
// model.message / session.end / session.start). Unknowns still skipped
// (safe default per original comment).
func parseLine(raw string) parsed {
	trim := strings.TrimSpace(raw)
	if trim == "" {
		return parsed{kind: lineSkip}
	}

	var ev grokEvent
	if err := json.Unmarshal([]byte(trim), &ev); err != nil {
		if !strings.HasPrefix(trim, "{") {
			return parsed{kind: lineDelta, delta: raw + "\n"}
		}
		return parsed{kind: lineSkip}
	}

	switch ev.Type {
	case "text", "model.message", "message":
		s := dataToString(ev.Data)
		if s == "" {
			s = dataToString(ev)
		}
		if s == "" {
			return parsed{kind: lineSkip}
		}
		return parsed{kind: lineDelta, delta: s}

	case "thought", "model.thinking", "thinking":
		s := dataToString(ev.Data)
		if s == "" {
			s = dataToString(ev)
		}
		if s == "" {
			return parsed{kind: lineSkip}
		}
		return parsed{kind: lineReasoning, delta: s}

	case "end", "session.end":
		sr := ev.StopReason
		sid := ev.SessionID
		if sid == "" {
			if m, ok := ev.Data.(map[string]any); ok {
				if s, ok := m["sessionId"].(string); ok && s != "" {
					sid = s
				}
				if sr == "" {
					if s, ok := m["stopReason"].(string); ok && s != "" {
						sr = s
					}
				}
			}
		}
		it, ot := extractUsage(ev)
		m := ev.Model
		if m == "" {
			if d, ok := ev.Data.(map[string]any); ok {
				if s, ok := d["model"].(string); ok && s != "" {
					m = s
				}
			}
		}
		return parsed{
			kind:         lineEnd,
			stopReason:   sr,
			sessionID:    sid,
			inputTokens:  it,
			outputTokens: ot,
			model:        m,
		}

	case "error":
		msg := ev.Message
		if msg == "" {
			msg = ev.Error
		}
		if msg == "" {
			msg = dataToString(ev.Data)
		}
		if msg == "" {
			return parsed{kind: lineSkip}
		}
		return parsed{kind: lineErr, errMsg: msg}

	case "tool.call", "tool_use", "toolUse":
		id := ev.ID
		name := ev.Tool
		args := ev.Args
		if id == "" || name == "" || args == nil {
			if m, ok := ev.Data.(map[string]any); ok && m != nil {
				if id == "" {
					if s, ok := m["id"].(string); ok {
						id = s
					}
				}
				if name == "" {
					if s, ok := m["tool"].(string); ok {
						name = s
					}
					if name == "" {
						if s, ok := m["name"].(string); ok {
							name = s
						}
					}
				}
				if args == nil {
					if a := m["args"]; a != nil {
						args = a
					}
					if args == nil {
						if a := m["input"]; a != nil {
							args = a
						}
					}
				}
			}
		}
		if name == "" {
			return parsed{kind: lineSkip}
		}
		return parsed{
			kind:     lineToolUse,
			toolID:   id,
			toolName: name,
			toolArgs: args,
		}

	case "tool.result", "tool_result", "toolResult":
		id := ev.ID
		content := dataToString(ev.Content)
		if content == "" {
			content = dataToString(ev.Data)
		}
		if id == "" {
			if m, ok := ev.Data.(map[string]any); ok {
				if s, ok := m["id"].(string); ok && s != "" {
					id = s
				}
				if s, ok := m["tool_use_id"].(string); ok && s != "" {
					id = s
				}
				if content == "" {
					if c := m["content"]; c != nil {
						content = dataToString(c)
					}
				}
			}
		}
		return parsed{
			kind:          lineToolResult,
			resultID:      id,
			resultContent: content,
		}

	case "session.start", "usage":
		// session.start: we only care about sessionId for resume (usually
		// also appears on end); usage: tokens may be here but we prefer
		// end for now. Capture what we can on start too for robustness.
		it, ot := extractUsage(ev)
		sid := ev.SessionID
		mdl := ev.Model
		if sid == "" || mdl == "" {
			if d, ok := ev.Data.(map[string]any); ok {
				if sid == "" {
					if s, ok := d["sessionId"].(string); ok {
						sid = s
					}
				}
				if mdl == "" {
					if s, ok := d["model"].(string); ok && s != "" {
						mdl = s
					}
				}
			}
		}
		if sid != "" || it > 0 || ot > 0 || mdl != "" {
			return parsed{
				kind:         lineEnd, // reuse end path for sid/tokens (harmless if no stop)
				sessionID:    sid,
				inputTokens:  it,
				outputTokens: ot,
				model:        mdl,
			}
		}
		return parsed{kind: lineSkip}

	default:
		// Unknown event type — silently skip so a CLI bump doesn't
		// crash the stream. The high-signal ones (tool.call etc) now
		// have branches; future ones will be added as they appear.
		return parsed{kind: lineSkip}
	}
}

// extractUsage pulls token counts from a grokEvent (end/usage/start)
// trying top-level fields + common nested shapes. Returns zeros if
// nothing found (current grok-build-0.1 subscription runs often omit
// numeric tokens; cost is tracked on xAI side).
func extractUsage(ev grokEvent) (int64, int64) {
	it := ev.InputTokens
	if it == 0 {
		it = ev.InputTokens2
	}
	ot := ev.OutputTokens
	if ot == 0 {
		ot = ev.OutputTokens2
	}
	if it == 0 && ot == 0 {
		cands := []any{ev.Data, ev.Content}
		for _, c := range cands {
			if m, ok := c.(map[string]any); ok && m != nil {
				if v, ok := m["input_tokens"].(float64); ok && v > 0 {
					it = int64(v)
				}
				if v, ok := m["output_tokens"].(float64); ok && v > 0 {
					ot = int64(v)
				}
				if it == 0 {
					if v, ok := m["inputTokens"].(float64); ok && v > 0 {
						it = int64(v)
					}
				}
				if ot == 0 {
					if v, ok := m["outputTokens"].(float64); ok && v > 0 {
						ot = int64(v)
					}
				}
				if u, ok := m["usage"].(map[string]any); ok && u != nil {
					if v, ok := u["input_tokens"].(float64); ok && it == 0 {
						it = int64(v)
					}
					if v, ok := u["output_tokens"].(float64); ok && ot == 0 {
						ot = int64(v)
					}
				}
			}
		}
	}
	return it, ot
}

// dataToString unwraps the `data` field, which observed forms include:
// plain string ("hi"), object with text/content, or escape-encoded JSON.
func dataToString(v any) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		if s, ok := t["text"].(string); ok && s != "" {
			return s
		}
		if s, ok := t["content"].(string); ok && s != "" {
			return s
		}
	}
	if b, err := json.Marshal(v); err == nil {
		return string(b)
	}
	return ""
}
