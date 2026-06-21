// Events — parse the claude CLI's stream-json stdout into stream.Chunk
// events that the SSE emitter can serialise verbatim.
//
// The binary emits one JSON object per line on stdout. Event types:
//   - {type:"assistant",  message:{content:[{type:"text",  text:...},
//                                             {type:"thinking", thinking:...},
//                                             {type:"tool_use", id, name, input}]}}
//   - {type:"user",       message:{content:[{type:"tool_result", tool_use_id, content}]}}
//   - {type:"result",     session_id, result, total_cost_usd, usage:{input_tokens, output_tokens,
//                          cache_creation_input_tokens, cache_read_input_tokens},
//                          stop_reason, is_error?, error?, permission_denials?}
//   - {type:"system",     subtype:..., ...}        (init / mcp_server messages — informational)
//
// We map onto the existing stream.Chunk types in go-core/internal/stream/types.go:
//   - text deltas → ChunkTypeDelta
//   - thinking blocks → ChunkTypeReasoning
//   - tool_use → ChunkTypeToolUse
//   - tool_result → ChunkTypeToolResult
//   - result.is_error → ChunkTypeError
//   - clean result → ChunkTypeDone
//
// processStream is the inner-loop, parameterised on stdout/stderr
// readers + an emit closure, so tests can drive parsing without
// spawning a real subprocess.
package claudebinary

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/yha/core/internal/stream"
)

// traceUsage gates a temporary diagnostic that dumps per-event usage
// to stderr (pm2 routes that to /home/user/.pm2/logs/YHA-Core-error.log).
// Default OFF — it was a json.Marshal + synchronous stderr write per
// assistant/result event, on always while the "tokens always zero" bug was
// being chased. Opt back in with YHA_TRACE_CB_USAGE=1 if that flow needs
// re-verifying; remove entirely once the fp.InputTokens path is trusted.
var traceUsage = func() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("YHA_TRACE_CB_USAGE")))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}()

func traceUsageLog(stage string, fields map[string]any) {
	if !traceUsage {
		return
	}
	blob, _ := json.Marshal(fields)
	fmt.Fprintf(os.Stderr, "{\"trace\":\"claudebinary.usage\",\"stage\":%q,\"fields\":%s}\n", stage, blob)
}

// Result aggregates the post-stream state the route handler needs:
// final text, accumulated cost/tokens, last stop reason, and the
// claude binary's session_id (for resume on the next turn).
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
	// PermDenials accumulates unique tool-name → denial blob across all
	// turns of a single spawn. The serialised form is emitted on each
	// detected denial as a chunk; the post-stream caller can also read
	// the map for telemetry.
	PermDenials map[string]any
}

// EventStats is the tally read after processStream returns. The
// caller uses it to decide whether the spawn produced any output
// (retry on stale-resume), populate Result fields, etc.
type EventStats struct {
	Lines        int    // total stdout lines consumed
	JSONLines    int    // lines successfully parsed as JSON
	ResultEvents int    // count of "result" events seen
	StderrText   string // concatenated stderr (capped via cap on caller)
}

// EventEmit is the callback for each chunk parsed out of the binary's
// stdout. Distinct from stream.EmitFn so we can pre-process / fan to
// multiple consumers in the route layer (live SSE, buffer, etc.).
type EventEmit func(stream.Chunk)

// PermDenialEmit is the callback for permission-denial state changes.
// Fires whenever the dedup map grows by at least one entry; the
// argument is the latest snapshot. Optional; nil disables the path.
type PermDenialEmit func(map[string]any)

// PendingTurnHook is invoked on each "result" event — caller decrements
// its own pendingTurns counter. Returns true when the spawn should
// finalize after this event (used by stream loop to coordinate stdin
// closure on the last turn). Optional; nil disables the path.
type PendingTurnHook func(ev ResultEvent) (finalize bool)

// ResultEvent surfaces the "result" payload to the caller. Lifted out
// of the raw JSON because the stream loop needs both the per-turn
// usage and the cumulative cost.
type ResultEvent struct {
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
	PermissionDenials   []map[string]any
}

// processStream reads stdout one line at a time, parses each as a
// claude stream-json event, and emits stream.Chunks via emit. stderr
// is concurrently drained into a capped buffer so the caller can
// surface it on error. Returns when stdout EOFs, ctx is cancelled,
// or a parse error makes further progress impossible (rare — most
// non-JSON lines are silently skipped, mirroring the TS behaviour).
//
// onPerm fires with the latest accumulated dedup map; onTurn fires per
// "result" event so the streaming caller can coordinate multi-turn
// stdin lifecycle. Both may be nil.
//
// Returns the aggregated Result, the EventStats tally, and any error
// the reader hit (excluding io.EOF).
func processStream(
	ctx context.Context,
	stdout, stderr io.Reader,
	emit EventEmit,
	onPerm PermDenialEmit,
	onTurn PendingTurnHook,
) (Result, EventStats, error) {
	var (
		result  Result
		stats   EventStats
		fullTxt strings.Builder
	)
	result.PermDenials = map[string]any{}

	// Concurrent stderr drain. Bounded to 16 KiB so a noisy child
	// can't OOM us. The post-loop logic uses StderrText for the
	// "No conversation found with session ID" retry.
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

	// Bumped from the default 64 KiB token size — a single content
	// block (large tool_result payload, large thinking) can easily
	// blow past that. 4 MiB is generous but not unbounded.
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	// Map of tool_use id → tool name so a later tool_result can
	// resolve the permission-denial tool name (matches the TS
	// toolNames Map).
	toolNames := map[string]string{}

	// Per-turn usage fallback. The binary emits `message.usage` on every
	// assistant event, and a fuller `usage` block on the terminal
	// "result" event. We prefer the result-event totals (they're the
	// authoritative per-turn aggregate), but stash the latest assistant
	// usage so we can fall back to it if the result event ever lands
	// without a populated usage block. Reset on each result event.
	var lastAssistantUsage usageDelta

	// Running turn-cumulative usage stamped on the in-flight chunks (see
	// handleAssistantEvent). Distinct from lastAssistantUsage, which holds
	// only the latest single message and is used solely as the result-event
	// fallback: this is the monotonic sum the live busy bar reads off the
	// chunks. Deliberately never reset across result events — result.*
	// accumulates the same way (+=), so the live total tracks the final
	// total across multi-turn /btw spawns too.
	var cumUsage usageDelta

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
			u := handleAssistantEvent(raw, emit, &fullTxt, toolNames, &cumUsage)
			traceUsageLog("assistant", map[string]any{
				"input": u.Input, "output": u.Output,
				"cacheCreate": u.CacheCreate, "cacheRead": u.CacheRead,
				"populated": u.populated(),
			})
			if u.populated() {
				lastAssistantUsage = u
			}
		case "user":
			handlePermDenials := handleUserEvent(raw, emit, toolNames)
			if handlePermDenials != nil {
				for k, v := range handlePermDenials {
					if _, dup := result.PermDenials[k]; !dup {
						result.PermDenials[k] = v
					}
				}
				if onPerm != nil {
					onPerm(snapshotMap(result.PermDenials))
				}
			}
		case "result":
			stats.ResultEvents++
			ev := parseResultEvent(raw)
			traceUsageLog("result", map[string]any{
				"input": ev.InputTokens, "output": ev.OutputTokens,
				"cacheCreate": ev.CacheCreationTokens, "cacheRead": ev.CacheReadTokens,
				"stopReason": ev.StopReason, "cost": ev.TotalCostUSD,
				"lastAssistantInput": lastAssistantUsage.Input,
				"lastAssistantOutput": lastAssistantUsage.Output,
			})
			// Fall back to the latest assistant-event usage when the
			// result event arrives without its own usage block. Newer
			// binaries occasionally omit the per-turn usage on result
			// and only surface it on the assistant message preceding it
			// — without this fold, fp.InputTokens reaches the Node
			// /internal/cost-event handler as 0 and the bridge records
			// a $0 turn.
			if ev.InputTokens == 0 && lastAssistantUsage.Input > 0 {
				ev.InputTokens = lastAssistantUsage.Input
			}
			if ev.OutputTokens == 0 && lastAssistantUsage.Output > 0 {
				ev.OutputTokens = lastAssistantUsage.Output
			}
			if ev.CacheCreationTokens == 0 && lastAssistantUsage.CacheCreate > 0 {
				ev.CacheCreationTokens = lastAssistantUsage.CacheCreate
			}
			if ev.CacheReadTokens == 0 && lastAssistantUsage.CacheRead > 0 {
				ev.CacheReadTokens = lastAssistantUsage.CacheRead
			}
			lastAssistantUsage = usageDelta{}
			// Fold per-event into the aggregated Result.
			if ev.SessionID != "" {
				result.ClaudeSessionID = ev.SessionID
			}
			if ev.TotalCostUSD != 0 {
				// total_cost_usd is cumulative across the conversation —
				// the latest result wins (matches TS comment).
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
			} else {
				// Emit the FE-visible terminator at result-event time.
				// claude CLI sometimes lingers tens of seconds after the
				// model is done (TLS teardown, MCP plugin shutdown), but
				// the per-stream UI must flip "running" → "done" the
				// instant the model finishes. Without this the FE would
				// wait for handles.Wait() in the parent streamer, which
				// may not return until the kill-watchdog fires (~30s).
				//
				// Route's dispatchHarnessAdapter tracks `endEmitted` and
				// will not synthesize a second terminator when it sees
				// this one go by. Mirrors bridge endChunk shape.
				stop := ev.StopReason
				if stop == "" {
					stop = "end_turn"
				}
				emit(stream.Chunk{
					Type:                stream.ChunkTypeDone,
					End:                 true,
					StopReason:          stop,
					InputTokens:         result.InputTokens,
					OutputTokens:        result.OutputTokens,
					CacheReadTokens:     result.CacheReadTokens,
					CacheCreationTokens: result.CacheCreationTokens,
					Cost:                result.Cost,
					Provider:            "claude-binary",
				})
			}
			// Accumulate any permission_denials surfaced via the result
			// event itself (the binary occasionally emits them here in
			// addition to / instead of the tool_result content).
			grew := false
			for _, d := range ev.PermissionDenials {
				name, _ := d["tool_name"].(string)
				if name == "" {
					if id, ok := d["tool_use_id"].(string); ok && id != "" {
						name = id
					}
				}
				if name == "" {
					// Fall back to a stringified blob so we still dedup.
					blob, _ := json.Marshal(d)
					name = string(blob)
				}
				if _, dup := result.PermDenials[name]; !dup {
					result.PermDenials[name] = d
					grew = true
				}
			}
			if grew && onPerm != nil {
				onPerm(snapshotMap(result.PermDenials))
			}
			// Reset fullTxt for any subsequent /btw turn (mirrors TS).
			fullTxt.Reset()
			if onTurn != nil {
				if finalize := onTurn(ev); finalize {
					// Caller signals it doesn't want more turns; we
					// still keep reading until EOF so /btw mid-turn
					// writes finish flushing — but the caller can
					// proactively close stdin from its hook.
				}
			}
		case "system":
			// Informational — init / mcp_server status / model
			// selection. Surface as a typed system-event chunk so the
			// debug UI can render MCP handshake + harness boot details
			// without the binary's quirks bleeding into the model's
			// reply text. Kind defaults to "info" when the binary
			// omits a subtype.
			kind, _ := raw["subtype"].(string)
			if kind == "" {
				kind, _ = raw["event"].(string)
			}
			if kind == "" {
				kind = "info"
			}
			emit(stream.Chunk{
				Type: stream.ChunkTypeSystem,
				SystemEvent: &stream.SystemEvent{
					Kind:    kind,
					Source:  "claude-binary",
					Payload: raw,
				},
			})
		}
	}

	stats.StderrText = <-stderrCh
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return result, stats, fmt.Errorf("processStream: scanner: %w", err)
	}

	// Final text fallback: if no "result" event landed (unusual — the
	// binary normally always emits one) but assistant text streamed,
	// promote fullTxt so the caller sees something. Matches the TS
	// `lastResultText = ev.result || fullText` fallback semantics.
	if result.Text == "" && fullTxt.Len() > 0 {
		result.Text = fullTxt.String()
	}
	// Same fallback for usage: if no result event was ever folded in
	// but assistant events carried per-message usage, surface that so
	// the caller still records a non-zero cost. Without this, a kill
	// watchdog cutting the child between the last assistant event and
	// the result event would silently zero out the turn.
	if stats.ResultEvents == 0 && lastAssistantUsage.populated() {
		result.InputTokens = lastAssistantUsage.Input
		result.OutputTokens = lastAssistantUsage.Output
		result.CacheCreationTokens = lastAssistantUsage.CacheCreate
		result.CacheReadTokens = lastAssistantUsage.CacheRead
	}
	traceUsageLog("final", map[string]any{
		"input": result.InputTokens, "output": result.OutputTokens,
		"cacheCreate": result.CacheCreationTokens, "cacheRead": result.CacheReadTokens,
		"cost": result.Cost, "stopReason": result.StopReason,
		"resultEvents": stats.ResultEvents, "lines": stats.Lines, "jsonLines": stats.JSONLines,
		"lastAssistantPopulated": lastAssistantUsage.populated(),
	})
	return result, stats, nil
}

// usageDelta carries the token-usage numbers extracted from a single
// `message.usage` block. Used both as the assistant-event fallback for
// the per-turn result event and as a typed return value for
// handleAssistantEvent.
type usageDelta struct {
	Input       int
	Output      int
	CacheCreate int
	CacheRead   int
}

// populated reports whether any field on the delta is non-zero. Used
// to decide whether to overwrite a tracked usage snapshot — assistant
// events without a usage block (rare, but the wire format allows it)
// shouldn't blow away a prior real reading.
func (u usageDelta) populated() bool {
	return u.Input != 0 || u.Output != 0 || u.CacheCreate != 0 || u.CacheRead != 0
}

// parseUsage extracts the four token counts out of a `message.usage`
// block. Tolerant of missing fields; returns zero values for absent
// numbers so callers can decide whether to overwrite tracked state.
func parseUsage(msg map[string]any) usageDelta {
	usage, ok := msg["usage"].(map[string]any)
	if !ok {
		return usageDelta{}
	}
	return usageDelta{
		Input:       asInt(usage["input_tokens"]),
		Output:      asInt(usage["output_tokens"]),
		CacheCreate: asInt(usage["cache_creation_input_tokens"]),
		CacheRead:   asInt(usage["cache_read_input_tokens"]),
	}
}

// handleAssistantEvent emits delta/reasoning/tool_use chunks for an
// "assistant" message. fullTxt accumulates text across all blocks so
// the post-stream caller has the full assistant message even when
// no "result" event surfaces it. Returns the message-level usage so
// the outer loop can keep a per-turn fallback for the result event.
func handleAssistantEvent(raw map[string]any, emit EventEmit, fullTxt *strings.Builder, toolNames map[string]string, cum *usageDelta) usageDelta {
	msg, _ := raw["message"].(map[string]any)
	if msg == nil {
		return usageDelta{}
	}
	// Parse the usage block up front so it can ride along on every chunk
	// this event emits. The route's harness live-meta ticker reads these
	// fields off the in-flight chunks to paint a token count on the busy
	// bar from the turn's start — claude-binary doesn't surface running
	// usage any other way (it only returns totals at finalize). Fields
	// are omitempty, so a usage-less assistant event adds no wire bytes.
	u := parseUsage(msg)
	// claude-binary reports each assistant message's OWN usage, not a running
	// turn total. Fold it into the caller's turn-cumulative and stamp THAT on
	// the chunks so the live busy bar climbs monotonically toward the turn
	// total, instead of showing only the latest step — which collapses output
	// to single digits after every tool round-trip and input to the uncached
	// ~2 delta under prompt caching. The terminal result event remains the
	// authoritative final total; this drives only the in-flight live display.
	cum.Input += u.Input
	cum.Output += u.Output
	cum.CacheCreate += u.CacheCreate
	cum.CacheRead += u.CacheRead
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
				Type:                stream.ChunkTypeDelta,
				Text:                text,
				Delta:               text,
				InputTokens:         cum.Input,
				OutputTokens:        cum.Output,
				CacheReadTokens:     cum.CacheRead,
				CacheCreationTokens: cum.CacheCreate,
			})
		case "thinking":
			thinking, _ := block["thinking"].(string)
			emit(stream.Chunk{
				Type:                stream.ChunkTypeReasoning,
				Reasoning:           thinking,
				InputTokens:         cum.Input,
				OutputTokens:        cum.Output,
				CacheReadTokens:     cum.CacheRead,
				CacheCreationTokens: cum.CacheCreate,
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
				InputTokens:         cum.Input,
				OutputTokens:        cum.Output,
				CacheReadTokens:     cum.CacheRead,
				CacheCreationTokens: cum.CacheCreate,
			})
		}
	}
	return u
}

// handleUserEvent emits tool_result chunks. Returns a map of NEW
// permission denials this call saw (so the outer loop can fold them
// into the dedup state). The map's keys are tool names; values are
// the denial blob (for telemetry).
func handleUserEvent(raw map[string]any, emit EventEmit, toolNames map[string]string) map[string]any {
	msg, _ := raw["message"].(map[string]any)
	if msg == nil {
		return nil
	}
	contentList, _ := msg["content"].([]any)
	var denials map[string]any
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
		// OK vs error isn't surfaced by the binary at this layer; default
		// to OK and let permission-denied detection downstream flip
		// telemetry where it matters.
		emit(stream.Chunk{
			Type: stream.ChunkTypeToolResult,
			ToolResult: &stream.ToolResultChunk{
				ID:      id,
				OK:      true,
				Content: preview,
			},
		})
		// Permission-denied detection. We only flag the FIRST time a
		// given tool name shows up so repeated denials don't spam.
		for _, pattern := range PermDeniedPatterns {
			if strings.Contains(content, pattern) {
				name := toolNames[id]
				if name == "" {
					if id != "" {
						name = id
					} else {
						name = "unknown"
					}
				}
				if denials == nil {
					denials = map[string]any{}
				}
				denials[name] = map[string]any{
					"tool_name":  name,
					"tool_input": map[string]any{},
				}
				break
			}
		}
	}
	return denials
}

// stringifyToolResultContent normalises the heterogeneous shapes the
// binary uses for block.content (string, array of blocks, object).
// TS does String(block.content ?? ''); we mirror that loosely with a
// JSON fallback for non-string types.
func stringifyToolResultContent(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// parseResultEvent unpacks the "result" event into a typed struct.
// Tolerant of missing fields; defaults are zero values.
func parseResultEvent(raw map[string]any) ResultEvent {
	ev := ResultEvent{}
	ev.SessionID, _ = raw["session_id"].(string)
	ev.Result, _ = raw["result"].(string)
	ev.TotalCostUSD = asFloat64(raw["total_cost_usd"])
	// Top-level tokens (older binary versions) OR usage.* (current).
	// Mirrors the TS `ev.input_tokens || ev.usage?.input_tokens` chain.
	ev.InputTokens = asInt(raw["input_tokens"])
	ev.OutputTokens = asInt(raw["output_tokens"])
	u := parseUsage(raw)
	if ev.InputTokens == 0 {
		ev.InputTokens = u.Input
	}
	if ev.OutputTokens == 0 {
		ev.OutputTokens = u.Output
	}
	ev.CacheCreationTokens = u.CacheCreate
	ev.CacheReadTokens = u.CacheRead
	ev.StopReason, _ = raw["stop_reason"].(string)
	if v, ok := raw["is_error"].(bool); ok && v {
		ev.IsError = true
		if e, ok := raw["result"].(string); ok && e != "" {
			ev.ErrorMessage = e
		} else if e, ok := raw["error"].(string); ok && e != "" {
			ev.ErrorMessage = e
		} else {
			ev.ErrorMessage = "claude returned an error"
		}
	}
	if list, ok := raw["permission_denials"].([]any); ok {
		for _, d := range list {
			if m, ok := d.(map[string]any); ok {
				ev.PermissionDenials = append(ev.PermissionDenials, m)
			}
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

// snapshotMap returns a shallow copy of m so callers can iterate
// without holding the producer's lock.
func snapshotMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// permDenialMu guards the PermDenial fan-out in tests that call
// handleUserEvent concurrently. processStream itself is single-reader
// so the map writes there don't need a lock.
var permDenialMu sync.Mutex // nolint: unused — kept for future external use
