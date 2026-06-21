// Package codex hosts the Go port of bridge/providers/codex.ts. The
// `codex` CLI is OpenAI's subscription/CLI-mode binary that runs as a
// long-lived subprocess and emits its own JSON-Lines event format on
// stdout. This package consumes that stream and translates it into
// the unified stream.Chunk shape used by the rest of yha-core.
//
// What's in scope (Phase 6b):
//   - streaming a single turn (Run) under a context cancellable from
//     the route handler
//   - parsing codex's JSON-Line wire format (events.go)
//   - subprocess spawn + env shaping (spawn.go) — including OPENAI_API_KEY,
//     CODEX_HOME, and an isolated HOME for multi-subscription rigs
//   - reporting back usage via Done.Usage so the route's finalize hook
//     can post real token counts to Node's /internal/cost-event
//
// What's NOT ported (intentionally left in Node):
//   - splitAllowedToolsByProvider — chat-routing concern, not harness
//   - btw-queue (mid-turn injection) — the App Server protocol port
//     for true bidirectional comms is a separate phase
//
// The package depends only on the stream package (Chunk types) and
// the standard library — keeping the harness self-contained so a
// future shared-spawn extraction (see GO-Ownership-Plan.md Phase 6+)
// can fold it together with the claude-binary harness without
// touching either's API surface.
package codex

import (
	"encoding/json"
	"strings"
)

// codexEvent is the lightly-typed view of a codex CLI stdout JSON line.
// The wire format mixes top-level fields (type, delta, message, …)
// with nested `item` and `usage` blocks. We decode it as a generic
// envelope and shape it via accessors so a future codex-CLI schema
// bump only touches this struct, not the loop.
//
// Codex emits roughly these event types we care about:
//
//	response.text.delta             — streamed assistant text
//	item.started / item.completed   — tool / agent_message lifecycle
//	response.output_item.added      — OpenAI-shape function_call start
//	response.function_call_arguments.delta / .done — args streaming
//	response.output_item.done       — function_call_output result
//	turn.completed                  — final event, carries usage
//	turn.failed                     — terminal error
//	error                           — non-fatal stream error
//
// Anything else with no `type` field but with `delta` / `text` /
// `content` is treated as a raw text passthrough (matches Node's
// fallback in codex.ts:407-411).
type codexEvent struct {
	Type      string          `json:"type"`
	Delta     string          `json:"delta"`
	Text      string          `json:"text"`
	Content   any             `json:"content"`
	Message   string          `json:"message"`
	CallID    string          `json:"call_id"`
	Arguments string          `json:"arguments"`
	Item      *codexItem      `json:"item"`
	Usage     *codexUsage     `json:"usage"`
	Error     *codexErrorBody `json:"error"`
	Payload   json.RawMessage `json:"payload"`
}

// codexWrappedPayload is the newer Codex CLI JSONL shape used by the
// standalone binary/session logs: a top-level {type:"response_item"|"event_msg",
// payload:{...}} wrapper. Keep it permissive so the parser survives CLI
// schema drift.
type codexWrappedPayload struct {
	Type             string          `json:"type"`
	Role             string          `json:"role"`
	Name             string          `json:"name"`
	CallID           string          `json:"call_id"`
	Arguments        any             `json:"arguments"`
	Output           any             `json:"output"`
	Message          string          `json:"message"`
	LastAgentMessage string          `json:"last_agent_message"`
	Content          []codexContent2 `json:"content"`
}

type codexContent2 struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// codexItem is the nested per-tool / per-message payload.
//
// Codex represents both inline messages and tool calls as items, so
// the shape varies by Type:
//
//	agent_message      — Text or Content[]
//	command_execution  — Command string
//	mcp_tool_call      — Server + Tool + Arguments + Result|Error
//	function_call      — Name + CallID + Arguments (OpenAI-ish)
//	function_call_output — CallID + Output (string|any)
//	web_search / todo_list / file_change / ... — native codex tools
type codexItem struct {
	ID               string         `json:"id"`
	Type             string         `json:"type"`
	Text             string         `json:"text"`
	Content          []codexContent `json:"content"`
	Command          string         `json:"command"`
	Server           string         `json:"server"`
	Tool             string         `json:"tool"`
	Name             string         `json:"name"`
	CallID           string         `json:"call_id"`
	Arguments        any            `json:"arguments"`
	Input            map[string]any `json:"input"`
	Output           any            `json:"output"`
	Result           any            `json:"result"`
	Error            any            `json:"error"`
	Status           string         `json:"status"`
	Action           map[string]any `json:"action"`
	AggregatedOutput string         `json:"aggregated_output"`
	ExitCode         *int           `json:"exit_code"`
	// Catch-all: keep the raw decoded view so native-tool fallbacks
	// can pluck arbitrary keys (todos/items/entries/operations,
	// path/paths/file/files/changes/diff/summary, etc.) without
	// minting a typed field for each.
	Raw map[string]any `json:"-"`
}

// codexContent mirrors the agent_message content array entries.
type codexContent struct {
	Text string `json:"text"`
}

// codexUsage is emitted on turn.completed.
//
// input_tokens here is GROSS (includes cached_tokens); the Node side
// subtracts cached_tokens before reporting "input" to observability.
// We do the same in Done().Usage so the wire shape stays identical.
type codexUsage struct {
	InputTokens        int                `json:"input_tokens"`
	OutputTokens       int                `json:"output_tokens"`
	InputTokensDetails *codexUsageDetails `json:"input_tokens_details"`
}

type codexUsageDetails struct {
	CachedTokens int `json:"cached_tokens"`
}

type codexErrorBody struct {
	Message string `json:"message"`
}

// rawUsage is the net token counts the parser reports back to the
// engine (Streamer.Run). InputTokens is the NET (gross - cached) so
// the public adapter in harness.go can fold it directly into the
// outer harness.Usage without re-doing the subtraction.
//
// Kept unexported: the public surface is harness.Codex / harness.Usage,
// which is constructed by the adapter in harness.go.
type rawUsage struct {
	InputTokens         int
	OutputTokens        int
	CacheReadTokens     int
	CacheCreationTokens int
}

// parsed is the loop's per-line decoded form. lineKind controls which
// fields are meaningful. We split decoding from emission so unit tests
// can drive the loop with fixture readers and assert on the chunk
// sequence without spawning a real codex.
type parsed struct {
	kind    lineKind
	delta   string        // text appended to fullText
	toolUse *toolUseShape // tool_use chunk to emit
	toolRes *toolResShape // tool_result chunk to emit
	usage   *rawUsage     // populated on turn.completed
	errMsg  string        // populated on `error` / `turn.failed`
}

type lineKind int

const (
	lineSkip lineKind = iota
	lineDelta
	lineToolUse
	lineToolResult
	lineToolUseAndResult
	lineUsage
	lineErr
)

type toolUseShape struct {
	ID    string
	Name  string
	Input map[string]any
}

type toolResShape struct {
	ID      string
	Content string
}

// parseLine decodes one stdout line. Lines that aren't JSON fall into
// the "raw text passthrough" branch (mirrors codex.ts:413-418). The
// returned parsed.kind tells the loop what to emit; multiple chunks
// may need to fire (e.g. item.completed with both a tool_use and a
// tool_result).
//
// state.startedItemIDs lets us suppress a duplicate tool_use chunk
// when a previous item.started already emitted one for the same id
// with non-empty input — matches Node's startedItemIds behaviour
// (codex.ts:370,378).
func parseLine(raw string, state *parseState) parsed {
	trim := strings.TrimSpace(raw)
	if trim == "" {
		return parsed{kind: lineSkip}
	}

	// Decode into our typed shape AND a raw map so native-tool
	// fallbacks can read keys we didn't pre-declare. json.Unmarshal
	// errors fall to the raw-text branch.
	var ev codexEvent
	if err := json.Unmarshal([]byte(trim), &ev); err != nil {
		// Non-JSON line. Codex occasionally emits log lines before
		// the JSON stream starts; Node passes them through as deltas
		// so the user sees something rather than a silent hang.
		if !strings.HasPrefix(trim, "{") {
			return parsed{kind: lineDelta, delta: raw + "\n"}
		}
		return parsed{kind: lineSkip}
	}
	// Side-load the raw map onto Item so native-tool fallbacks can
	// pluck unknown keys.
	if ev.Item != nil {
		var rawEnv map[string]any
		if err := json.Unmarshal([]byte(trim), &rawEnv); err == nil {
			if it, ok := rawEnv["item"].(map[string]any); ok {
				ev.Item.Raw = it
			}
		}
	}

	// Newer Codex CLI builds wrap all stream events in a top-level
	// response_item/event_msg envelope. The old parser only understood the
	// inner protocol (response.text.delta, item.completed, turn.completed,
	// ...), which meant a completed Codex turn could keep the YPA live row
	// stuck at streaming:true forever because event_msg/task_complete was
	// ignored while the subprocess kept inherited MCP handles open.
	if (ev.Type == "response_item" || ev.Type == "event_msg") && len(ev.Payload) > 0 {
		var wp codexWrappedPayload
		if err := json.Unmarshal(ev.Payload, &wp); err == nil {
			switch wp.Type {
			case "message":
				if wp.Role != "assistant" {
					return parsed{kind: lineSkip}
				}
				var b strings.Builder
				for _, c := range wp.Content {
					if c.Type == "output_text" || c.Type == "text" || c.Type == "" {
						b.WriteString(c.Text)
					}
				}
				if b.Len() == 0 {
					return parsed{kind: lineSkip}
				}
				return parsed{kind: lineDelta, delta: b.String()}
			case "function_call", "custom_tool_call", "tool_search_call":
				input := map[string]any{}
				switch a := wp.Arguments.(type) {
				case string:
					_ = json.Unmarshal([]byte(a), &input)
				case map[string]any:
					input = a
				}
				name := wp.Name
				if name == "" {
					name = wp.Type
				}
				return parsed{kind: lineToolUse, toolUse: &toolUseShape{ID: wp.CallID, Name: name, Input: input}}
			case "function_call_output", "custom_tool_call_output", "tool_search_output":
				return parsed{kind: lineToolResult, toolRes: &toolResShape{ID: wp.CallID, Content: anyToString(wp.Output)}}
			case "agent_message":
				// event_msg/agent_message is followed by response_item/message in
				// current CLI builds. Skip it to avoid duplicate final text.
				return parsed{kind: lineSkip}
			case "task_complete":
				return parsed{kind: lineUsage}
			}
		}
	}

	switch ev.Type {
	case "response.text.delta":
		if ev.Delta == "" {
			return parsed{kind: lineSkip}
		}
		return parsed{kind: lineDelta, delta: ev.Delta}

	case "item.started":
		if ev.Item == nil {
			return parsed{kind: lineSkip}
		}
		tu := mapItemToToolUse(ev.Item)
		if tu == nil {
			return parsed{kind: lineSkip}
		}
		if tu.ID != "" && hasOwnEntries(tu.Input) {
			state.startedItemIDs[tu.ID] = struct{}{}
		}
		return parsed{kind: lineToolUse, toolUse: tu}

	case "item.completed":
		if ev.Item == nil {
			return parsed{kind: lineSkip}
		}
		// agent_message — extract the inline text. Codex sometimes
		// only delivers the assistant message as the completed item
		// (no preceding response.text.delta stream), so this is the
		// last-chance hook to capture it.
		if ev.Item.Type == "agent_message" {
			text := ev.Item.Text
			if text == "" && len(ev.Item.Content) > 0 {
				var b strings.Builder
				for _, c := range ev.Item.Content {
					b.WriteString(c.Text)
				}
				text = b.String()
			}
			if text == "" {
				return parsed{kind: lineSkip}
			}
			return parsed{kind: lineDelta, delta: text}
		}
		tu := mapItemToToolUse(ev.Item)
		tr := mapItemToToolResult(ev.Item)
		out := parsed{}
		// Suppress duplicate tool_use when item.started already emitted
		// one for the same id (codex.ts:376).
		if tu != nil {
			if tu.ID == "" || !state.has(tu.ID) {
				out.toolUse = tu
			}
			delete(state.startedItemIDs, tu.ID)
		}
		if tr != nil {
			out.toolRes = tr
		}
		switch {
		case out.toolUse != nil && out.toolRes != nil:
			out.kind = lineToolUseAndResult
		case out.toolUse != nil:
			out.kind = lineToolUse
		case out.toolRes != nil:
			out.kind = lineToolResult
		default:
			out.kind = lineSkip
		}
		return out

	case "response.output_item.added":
		// OpenAI-style function_call start. Codex emits this AHEAD of
		// the argument deltas, so we track the call_id->name map and
		// hold the final tool_use emission until .done arrives. We
		// emit a placeholder tool_use here so the live SSE shows the
		// tool name immediately — matches Node's codex.ts:381.
		if ev.Item == nil || ev.Item.Type != "function_call" {
			return parsed{kind: lineSkip}
		}
		state.toolCalls[ev.Item.CallID] = &pendingToolCall{Name: ev.Item.Name}
		return parsed{
			kind: lineToolUse,
			toolUse: &toolUseShape{
				ID:    ev.Item.CallID,
				Name:  ev.Item.Name,
				Input: map[string]any{},
			},
		}

	case "response.function_call_arguments.delta":
		if ev.CallID == "" {
			return parsed{kind: lineSkip}
		}
		tc := state.toolCalls[ev.CallID]
		if tc != nil {
			tc.ArgsBuf += ev.Delta
		}
		return parsed{kind: lineSkip}

	case "response.function_call_arguments.done":
		if ev.CallID == "" {
			return parsed{kind: lineSkip}
		}
		tc := state.toolCalls[ev.CallID]
		if tc == nil {
			return parsed{kind: lineSkip}
		}
		// Prefer ev.Arguments (codex sends the final buffer there);
		// fall back to whatever we accumulated.
		args := ev.Arguments
		if args == "" {
			args = tc.ArgsBuf
		}
		input := map[string]any{}
		_ = json.Unmarshal([]byte(args), &input) // best-effort
		return parsed{
			kind: lineToolUse,
			toolUse: &toolUseShape{
				ID:    ev.CallID,
				Name:  tc.Name,
				Input: input,
			},
		}

	case "response.output_item.done":
		if ev.Item == nil || ev.Item.Type != "function_call_output" {
			return parsed{kind: lineSkip}
		}
		content := ""
		switch v := ev.Item.Output.(type) {
		case string:
			content = v
		case nil:
			content = ""
		default:
			if b, err := json.Marshal(v); err == nil {
				content = string(b)
			}
		}
		return parsed{
			kind: lineToolResult,
			toolRes: &toolResShape{
				ID:      ev.Item.CallID,
				Content: content,
			},
		}

	case "error":
		if ev.Message == "" {
			return parsed{kind: lineSkip}
		}
		return parsed{kind: lineErr, errMsg: ev.Message}

	case "turn.failed":
		msg := ""
		if ev.Error != nil {
			msg = ev.Error.Message
		}
		if msg == "" {
			return parsed{kind: lineSkip}
		}
		return parsed{kind: lineErr, errMsg: msg}

	case "turn.completed":
		if ev.Usage == nil {
			// turn.completed is the protocol-level terminal event even when
			// a future/buggy CLI omits usage. The process can keep stdout open
			// after this point (notably when an inherited MCP handle lingers),
			// so the runner must still be able to finish the YPA turn.
			return parsed{kind: lineUsage}
		}
		net := codexUsageToNet(ev.Usage)
		return parsed{kind: lineUsage, usage: &net}

	case "":
		// No type field — try to extract free-form text. This mirrors
		// Node's fallback (codex.ts:406-412): when codex emits a line
		// like {"delta": "..."} or {"text": "..."}, surface it.
		if ev.Delta != "" {
			return parsed{kind: lineDelta, delta: ev.Delta}
		}
		if ev.Text != "" {
			return parsed{kind: lineDelta, delta: ev.Text}
		}
		if s, ok := ev.Content.(string); ok && s != "" {
			return parsed{kind: lineDelta, delta: s}
		}
		return parsed{kind: lineSkip}

	default:
		// TODO: codex CLI may grow more event types; the Node side
		// silently ignores them and we should too rather than
		// crashing the stream. If a new high-signal event surfaces
		// (e.g. progress, reasoning), wire it explicitly above.
		return parsed{kind: lineSkip}
	}
}

// codexUsageToNet computes the NET input token count (gross - cached).
// Mirrors codex.ts:455-457.
func codexUsageToNet(u *codexUsage) rawUsage {
	cached := 0
	if u.InputTokensDetails != nil {
		cached = u.InputTokensDetails.CachedTokens
	}
	net := rawUsage{
		OutputTokens:    u.OutputTokens,
		CacheReadTokens: cached,
	}
	gross := u.InputTokens
	if gross > cached {
		net.InputTokens = gross - cached
	}
	return net
}

// ── Item → ToolUse / ToolResult mapping ────────────────────────────────────

// mapItemToToolUse mirrors codex.ts:196-218.
func mapItemToToolUse(item *codexItem) *toolUseShape {
	if item == nil {
		return nil
	}
	t := strings.TrimSpace(item.Type)
	if t == "" || t == "agent_message" {
		return nil
	}
	switch t {
	case "command_execution":
		return &toolUseShape{
			ID:    item.ID,
			Name:  "functions.exec_command",
			Input: map[string]any{"command": item.Command},
		}
	case "mcp_tool_call":
		args, _ := item.Arguments.(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		return &toolUseShape{
			ID:    item.ID,
			Name:  formatMcpToolName(item.Server, item.Tool, t),
			Input: args,
		}
	}
	return &toolUseShape{
		ID:    item.ID,
		Name:  formatNativeToolName(t),
		Input: extractNativeToolInput(item),
	}
}

// mapItemToToolResult mirrors codex.ts:220-254.
func mapItemToToolResult(item *codexItem) *toolResShape {
	if item == nil {
		return nil
	}
	t := strings.TrimSpace(item.Type)
	if t == "" || t == "agent_message" {
		return nil
	}
	switch t {
	case "command_execution":
		var lines []string
		if item.AggregatedOutput != "" {
			lines = append(lines, item.AggregatedOutput)
		}
		if item.ExitCode != nil {
			lines = append(lines, "[exit_code="+itoa(*item.ExitCode)+"]")
		}
		content := strings.TrimSpace(strings.Join(lines, "\n"))
		if content == "" {
			content = "(no output)"
		}
		return &toolResShape{ID: item.ID, Content: content}
	case "mcp_tool_call":
		text := ""
		if item.Error != nil {
			text = anyToString(item.Error)
		} else {
			text = resultToText(item.Result)
		}
		if text == "" {
			text = "(no output)"
		}
		return &toolResShape{ID: item.ID, Content: text}
	}
	native := extractNativeToolResult(item)
	if native != "" {
		return &toolResShape{ID: item.ID, Content: native}
	}
	if item.Output != nil {
		return &toolResShape{ID: item.ID, Content: anyToString(item.Output)}
	}
	return nil
}

// ── Native tool helpers (web_search, todo_list, file_change) ───────────────

// extractNativeToolInput mirrors codex.ts:107-164.
func extractNativeToolInput(item *codexItem) map[string]any {
	t := strings.TrimSpace(item.Type)
	if t == "" {
		return map[string]any{}
	}
	if hasOwnEntries(item.Input) {
		return item.Input
	}
	switch t {
	case "web_search":
		out := map[string]any{}
		if item.Status != "" {
			out["status"] = item.Status
		}
		if action := pickFields(item.Action, []string{"type", "query", "queries", "url"}); len(action) > 0 {
			out["action"] = action
		}
		if len(out) > 0 {
			return out
		}
	case "todo_list":
		out := pickFromRaw(item.Raw, []string{"todos", "items", "entries", "operations"})
		if len(out) > 0 {
			return out
		}
	case "file_change":
		out := pickFromRaw(item.Raw, []string{
			"path", "paths", "file", "files",
			"old_path", "new_path", "changes", "diff", "summary",
		})
		if len(out) > 0 {
			return out
		}
	}
	// Catch-all fallback: surface every non-trivial top-level field
	// the typed struct doesn't already own.
	out := map[string]any{}
	skip := map[string]struct{}{
		"id": {}, "type": {}, "status": {}, "input": {}, "output": {},
		"result": {}, "error": {}, "text": {}, "content": {},
		"aggregated_output": {}, "exit_code": {}, "call_id": {},
	}
	for k, v := range item.Raw {
		if _, drop := skip[k]; drop {
			continue
		}
		if !nontrivial(v) {
			continue
		}
		out[k] = v
	}
	return out
}

// extractNativeToolResult mirrors codex.ts:166-187.
func extractNativeToolResult(item *codexItem) string {
	t := strings.TrimSpace(item.Type)
	if t == "" {
		return ""
	}
	switch t {
	case "web_search":
		var lines []string
		if item.Status != "" {
			lines = append(lines, "status="+item.Status)
		}
		if item.Action != nil {
			if v, _ := item.Action["type"].(string); v != "" {
				lines = append(lines, "action="+v)
			}
			if v, _ := item.Action["query"].(string); v != "" {
				lines = append(lines, "query="+v)
			}
			if qs, ok := item.Action["queries"].([]any); ok && len(qs) > 1 {
				parts := make([]string, 0, len(qs))
				for _, q := range qs {
					parts = append(parts, anyToString(q))
				}
				lines = append(lines, "queries="+strings.Join(parts, " | "))
			}
			if v, _ := item.Action["url"].(string); v != "" {
				lines = append(lines, "url="+v)
			}
		}
		return strings.Join(lines, "\n")
	case "todo_list", "file_change":
		payload := extractNativeToolInput(item)
		if len(payload) > 0 {
			if b, err := json.Marshal(payload); err == nil {
				return string(b)
			}
		}
		return ""
	}
	if item.Result != nil {
		return resultToText(item.Result)
	}
	if item.Error != nil {
		return anyToString(item.Error)
	}
	return ""
}

// formatNativeToolName mirrors codex.ts:189-194.
func formatNativeToolName(t string) string {
	switch t {
	case "web_search":
		return "codex.WebSearch"
	case "todo_list":
		return "codex.TodoList"
	case "file_change":
		return "codex.FileChange"
	}
	return "codex." + t
}

// formatMcpToolName mirrors codex.ts:59-67.
func formatMcpToolName(server, tool, fallback string) string {
	s := strings.TrimSpace(server)
	t := strings.TrimSpace(tool)
	if s == "" && t == "" {
		return fallback
	}
	safeServer := sanitiseAlnumUnderscore(s)
	safeTool := strings.ReplaceAll(t, "-", "_")
	if safeServer != "" && safeTool != "" {
		return "mcp__" + safeServer + "__." + safeTool
	}
	if safeTool != "" {
		return safeTool
	}
	return safeServer
}

func sanitiseAlnumUnderscore(in string) string {
	var b strings.Builder
	lastUnderscore := false
	for _, r := range in {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
			lastUnderscore = false
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
			lastUnderscore = false
		case r >= '0' && r <= '9':
			b.WriteRune(r)
			lastUnderscore = false
		default:
			if b.Len() == 0 || lastUnderscore {
				continue
			}
			b.WriteRune('_')
			lastUnderscore = true
		}
	}
	return strings.Trim(b.String(), "_")
}

// resultToText is codex.ts:69-84 in Go form.
func resultToText(result any) string {
	if result == nil {
		return ""
	}
	if s, ok := result.(string); ok {
		return s
	}
	m, ok := result.(map[string]any)
	if !ok {
		// Fall through to JSON marshal.
		if b, err := json.Marshal(result); err == nil {
			return string(b)
		}
		return ""
	}
	if content, ok := m["content"].([]any); ok {
		var parts []string
		for _, p := range content {
			pm, ok := p.(map[string]any)
			if !ok {
				if b, err := json.Marshal(p); err == nil {
					parts = append(parts, string(b))
				}
				continue
			}
			if t, ok := pm["text"].(string); ok && t != "" {
				parts = append(parts, t)
				continue
			}
			if d, ok := pm["data"]; ok && d != nil {
				parts = append(parts, anyToString(d))
				continue
			}
			if b, err := json.Marshal(pm); err == nil {
				parts = append(parts, string(b))
			}
		}
		return strings.Join(filterNonEmpty(parts), "\n")
	}
	if sc, ok := m["structured_content"]; ok && sc != nil {
		if b, err := json.Marshal(sc); err == nil {
			return string(b)
		}
	}
	if b, err := json.Marshal(m); err == nil {
		return string(b)
	}
	return ""
}

// ── Tiny generic helpers ───────────────────────────────────────────────────

func hasOwnEntries(m map[string]any) bool { return len(m) > 0 }

func nontrivial(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(t) != ""
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	}
	return true
}

func pickFields(in map[string]any, keys []string) map[string]any {
	if in == nil {
		return nil
	}
	out := map[string]any{}
	for _, k := range keys {
		v, ok := in[k]
		if !ok || !nontrivial(v) {
			continue
		}
		out[k] = v
	}
	return out
}

func pickFromRaw(raw map[string]any, keys []string) map[string]any {
	if raw == nil {
		return nil
	}
	out := map[string]any{}
	for _, k := range keys {
		v, ok := raw[k]
		if !ok || !nontrivial(v) {
			continue
		}
		out[k] = v
	}
	return out
}

func filterNonEmpty(in []string) []string {
	out := in[:0]
	for _, s := range in {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func anyToString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	if b, err := json.Marshal(v); err == nil {
		return string(b)
	}
	return ""
}

func itoa(n int) string {
	// Avoid importing strconv just for this one site; the loop is hot
	// and we already pull encoding/json.
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// ── Per-stream parser state ────────────────────────────────────────────────

type pendingToolCall struct {
	Name    string
	ArgsBuf string
}

// parseState is owned by Run; passed to parseLine so it can dedupe
// duplicate item.started/completed pairs and accumulate function-call
// argument deltas across events.
type parseState struct {
	startedItemIDs map[string]struct{}
	toolCalls      map[string]*pendingToolCall
}

func newParseState() *parseState {
	return &parseState{
		startedItemIDs: map[string]struct{}{},
		toolCalls:      map[string]*pendingToolCall{},
	}
}

func (s *parseState) has(id string) bool {
	if id == "" {
		return false
	}
	_, ok := s.startedItemIDs[id]
	return ok
}
