// events.go — stream-json event parsing for the claude-sdk harness.
//
// The Node SDK's `query()` iterator yields the same {type:"assistant"|
// "user"|"result"|"system"} message shape the bare `claude` binary
// emits in --output-format stream-json mode. The SDK wraps the binary,
// so under the hood the wire format is identical.
//
// Rather than re-implement the parser, this file thinly delegates to
// the claudebinary package's exported processStream variants. We only
// need slim wrappers because:
//
//   - claudebinary.processStream is unexported. We copy the minimal
//     dispatch loop here so the package-level seam stays under our
//     control. (Attribution: lifted from
//     go-core/internal/harness/claudebinary/events.go, kept in sync.)
//   - claudebinary's ResultEvent / EventStats / Result types are
//     duplicated only in the public-facing aggregate (FinalizePayload);
//     internally we use the SAME parsing helpers via the exported
//     PermDeniedPatterns + the exported handler shapes.
//
// The wire format spec lives in claudebinary/events.go's package
// comment — we don't repeat it here.
package claudesdk

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/yha/core/internal/stream"
)

// Result is the post-stream aggregate for the SDK harness. Mirrors
// claudebinary.Result but kept as a separate type so the SDK port
// can evolve without bleeding through claudebinary's struct shape.
type Result struct {
	Text                string
	Cost                float64
	StopReason          string
	InputTokens         int
	OutputTokens        int
	CacheCreationTokens int
	CacheReadTokens     int
	ClaudeSessionID     string
	IsError             bool
	ErrorMessage        string
}

// EventStats is the loop tally read after processStream returns.
type EventStats struct {
	Lines        int    // total stdout lines consumed
	JSONLines    int    // lines successfully parsed as JSON
	ResultEvents int    // count of "result" events seen
	StderrText   string // concatenated stderr (capped)
}

// EventEmit is the callback for each parsed chunk. Distinct from
// stream.EmitFn so the harness layer can fan-out / pre-process before
// the SSE writer sees the chunk.
type EventEmit func(stream.Chunk)

// processStream reads stdout one line at a time, parses each as a
// claude stream-json event, and emits stream.Chunks via emit. stderr
// is drained concurrently and capped at 16 KiB for the post-stream
// error tail.
//
// Returns the aggregated Result, the EventStats tally, and any error
// the reader hit (excluding io.EOF). Non-JSON lines are silently
// skipped — matches the upstream binary's tolerance for log noise.
//
// (Attribution: mirrors claudebinary.processStream; only the result
// type names differ. Kept here so a future SDK-specific event subtype
// — e.g. mcp_handshake_complete — can be wired without editing the
// claudebinary package.)
func processStream(
	ctx context.Context,
	stdout, stderr io.Reader,
	emit EventEmit,
) (Result, EventStats, error) {
	var (
		result  Result
		stats   EventStats
		fullTxt strings.Builder
	)

	const stderrCap = 16 * 1024
	stderrCh := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			if ctx.Err() != nil {
				break
			}
			n, err := stderr.Read(buf)
			if n > 0 {
				if b.Len()+n > stderrCap {
					b.WriteString(string(buf[:stderrCap-b.Len()]))
					break
				}
				b.WriteString(string(buf[:n]))
			}
			if err != nil {
				break
			}
		}
		stderrCh <- b.String()
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	toolNames := map[string]string{}

	for scanner.Scan() {
		if ctx.Err() != nil {
			return result, stats, ctx.Err()
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		stats.Lines++

		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		stats.JSONLines++

		evType, _ := raw["type"].(string)
		switch evType {
		case "assistant":
			handleAssistantEvent(raw, emit, &fullTxt, toolNames)
		case "user":
			handleUserEvent(raw, emit)
		case "result":
			stats.ResultEvents++
			ev := parseResultEvent(raw)
			if ev.SessionID != "" {
				result.ClaudeSessionID = ev.SessionID
			}
			if ev.TotalCostUSD != 0 {
				result.Cost = ev.TotalCostUSD
			}
			result.InputTokens += ev.InputTokens
			result.OutputTokens += ev.OutputTokens
			result.CacheCreationTokens += ev.CacheCreationTokens
			result.CacheReadTokens += ev.CacheReadTokens
			if ev.StopReason != "" {
				result.StopReason = ev.StopReason
			}
			if ev.Result != "" {
				result.Text = ev.Result
			} else if fullTxt.Len() > 0 {
				result.Text = fullTxt.String()
			}
			if ev.IsError {
				result.IsError = true
				result.ErrorMessage = ev.ErrorMessage
				emit(stream.Chunk{Type: stream.ChunkTypeError, Error: ev.ErrorMessage})
			}
			fullTxt.Reset()
		case "system":
			// MCP handshake / init notifications — informational. The TS
			// SDK swallows these; we do the same until stream.Chunk has
			// a first-class system subtype.
			continue
		}
	}

	stats.StderrText = <-stderrCh
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return result, stats, fmt.Errorf("claudesdk.processStream: scanner: %w", err)
	}

	if result.Text == "" && fullTxt.Len() > 0 {
		result.Text = fullTxt.String()
	}
	return result, stats, nil
}

// resultEvent is the parsed payload of a "result" message. Kept
// package-private so the SDK port doesn't expose its parser shape
// to callers — they consume Result.
type resultEvent struct {
	SessionID           string
	Result              string
	TotalCostUSD        float64
	InputTokens         int
	OutputTokens        int
	CacheCreationTokens int
	CacheReadTokens     int
	StopReason          string
	IsError             bool
	ErrorMessage        string
}

// handleAssistantEvent emits delta / reasoning / tool_use chunks for
// an "assistant" message. fullTxt accumulates text across all blocks
// so the post-stream caller has the full assistant message even when
// no "result" event surfaces it. (Attribution: mirrors
// claudebinary.handleAssistantEvent.)
func handleAssistantEvent(raw map[string]any, emit EventEmit, fullTxt *strings.Builder, toolNames map[string]string) {
	msg, _ := raw["message"].(map[string]any)
	if msg == nil {
		return
	}
	contentList, _ := msg["content"].([]any)
	for _, b := range contentList {
		block, _ := b.(map[string]any)
		if block == nil {
			continue
		}
		blockType, _ := block["type"].(string)
		switch blockType {
		case "text":
			text, _ := block["text"].(string)
			if text == "" {
				continue
			}
			fullTxt.WriteString(text)
			emit(stream.Chunk{
				Type:  stream.ChunkTypeDelta,
				Text:  text,
				Delta: text,
			})
		case "thinking":
			thinking, _ := block["thinking"].(string)
			emit(stream.Chunk{
				Type:      stream.ChunkTypeReasoning,
				Reasoning: thinking,
			})
		case "tool_use":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			input, _ := block["input"].(map[string]any)
			if id != "" && name != "" {
				toolNames[id] = name
			}
			emit(stream.Chunk{
				Type: stream.ChunkTypeToolUse,
				ToolUse: &stream.ToolUseChunk{
					ID:    id,
					Name:  name,
					Input: input,
				},
			})
		}
	}
}

// handleUserEvent emits tool_result chunks. The SDK path doesn't
// surface permission-denial dedup the way the bare-binary path does
// (the SDK is configured with bypassPermissions), so we drop the
// pattern-matching branch here. (Attribution: mirrors
// claudebinary.handleUserEvent, slimmer.)
func handleUserEvent(raw map[string]any, emit EventEmit) {
	msg, _ := raw["message"].(map[string]any)
	if msg == nil {
		return
	}
	contentList, _ := msg["content"].([]any)
	for _, b := range contentList {
		block, _ := b.(map[string]any)
		if block == nil {
			continue
		}
		blockType, _ := block["type"].(string)
		if blockType != "tool_result" {
			continue
		}
		id, _ := block["tool_use_id"].(string)
		content := stringifyToolResultContent(block["content"])
		preview := content
		if len(preview) > 500 {
			preview = preview[:500]
		}
		emit(stream.Chunk{
			Type: stream.ChunkTypeToolResult,
			ToolResult: &stream.ToolResultChunk{
				ID:      id,
				OK:      true,
				Content: preview,
			},
		})
	}
}

// stringifyToolResultContent normalises the heterogeneous block.content
// shapes (string, array of {type:text,text}, plain object). Mirrors the
// TS String(block.content ?? ”) behaviour with a JSON fallback.
// (Attribution: mirrors claudebinary.stringifyToolResultContent.)
func stringifyToolResultContent(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	// Special-case Array<{type:'text', text:string}> — the SDK
	// streamClaudeViaSdk path joins their text fields rather than
	// JSON-encoding the array.
	if arr, ok := v.([]any); ok {
		var b strings.Builder
		for _, item := range arr {
			obj, _ := item.(map[string]any)
			if obj == nil {
				continue
			}
			if t, _ := obj["type"].(string); t == "text" {
				if txt, _ := obj["text"].(string); txt != "" {
					b.WriteString(txt)
				}
			}
		}
		if b.Len() > 0 {
			return b.String()
		}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// parseResultEvent unpacks the "result" event into a typed struct.
// Tolerant of missing fields; defaults are zero values.
// (Attribution: mirrors claudebinary.parseResultEvent.)
func parseResultEvent(raw map[string]any) resultEvent {
	ev := resultEvent{}
	ev.SessionID, _ = raw["session_id"].(string)
	ev.Result, _ = raw["result"].(string)
	ev.TotalCostUSD = asFloat64(raw["total_cost_usd"])
	ev.InputTokens = asInt(raw["input_tokens"])
	ev.OutputTokens = asInt(raw["output_tokens"])
	if usage, ok := raw["usage"].(map[string]any); ok {
		if ev.InputTokens == 0 {
			ev.InputTokens = asInt(usage["input_tokens"])
		}
		if ev.OutputTokens == 0 {
			ev.OutputTokens = asInt(usage["output_tokens"])
		}
		ev.CacheCreationTokens = asInt(usage["cache_creation_input_tokens"])
		ev.CacheReadTokens = asInt(usage["cache_read_input_tokens"])
	}
	ev.StopReason, _ = raw["stop_reason"].(string)
	if v, ok := raw["is_error"].(bool); ok && v {
		ev.IsError = true
		if e, ok := raw["result"].(string); ok && e != "" {
			ev.ErrorMessage = e
		} else if e, ok := raw["error"].(string); ok && e != "" {
			ev.ErrorMessage = e
		} else {
			ev.ErrorMessage = "claude SDK returned an error"
		}
	}
	return ev
}

func asInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return 0
}

func asFloat64(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}
