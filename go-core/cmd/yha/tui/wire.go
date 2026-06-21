package tui

// wire.go — body construction + SSE chunk decoding for the two stream
// routes the TUI talks to.
//
// /v1/stream/         Node bridge harness path. Body is PascalCase
//                     ({Input, Model, Effort, SessionId, ...}). SSE
//                     chunks are lowercase camelCase ({text, delta,
//                     reasoning, toolUse, toolResult, ...}). When the
//                     bridge is done it emits `data: [DONE]` plus an
//                     optional `{cost}`-style chunk.
//
// /v1/stream-direct/  Go-native path that hits the provider APIs from
//                     the daemon directly. Body is lowercase snake/camel
//                     ({input, model, max_tokens, ...}). SSE chunks
//                     mirror stream.Chunk.
//
// We keep both shapes alive so users can pick at flag time. Default is
// the harness path because the user is out of direct-API credit.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// streamPath returns the HTTP path for the chat POST given the user's
// --via choice. Anything but "direct" maps to harness so a typo doesn't
// burn API credit.
func streamPath(via string) string {
	if via == "direct" {
		return "/v1/stream-direct/"
	}
	return "/v1/stream/"
}

// buildSendBody assembles the JSON payload for the active --via path.
// Empty fields are omitted so the bridge falls back to its own defaults.
// provider is the Provider column from the model picker — when set, it
// pins routing to that exact row (e.g. "Anthropic-SUB2" for the second
// Claude subscription instance vs. "Anthropic API" for the paid path).
// Both routes accept PascalCase `Provider`: stream-direct/route.go:653
// reads it as part of the FE-shape struct that normalises to lower-case;
// the Node harness reads it via sanitizeAndValidateChatBody.
func buildSendBody(via, text, model, sessionID, effort, provider string) map[string]any {
	body := map[string]any{}
	if via == "direct" {
		body["input"] = text
		body["max_tokens"] = 4096
		if model != "" {
			body["model"] = model
		}
		if provider != "" {
			body["Provider"] = provider
		}
		if sessionID != "" {
			body["sessionId"] = sessionID
		}
		// stream-direct ignores Effort today; sending it is harmless but
		// we follow the user's spec: only attach when the harness path
		// asked for it.
		return body
	}

	// Harness / Node bridge — sanitizeAndValidateChatBody requires the
	// PascalCase keys. SessionId is required (the bridge generates one
	// per session); we fall back to a synthesised tui-* id below.
	body["Input"] = text
	if model != "" {
		body["Model"] = model
	}
	if provider != "" {
		body["Provider"] = provider
	}
	body["SessionId"] = sessionID
	if effort != "" {
		body["Effort"] = effort
	}
	return body
}

// finalSessionID picks the session id to attach to a /v1/stream/ POST.
// The bridge's validator requires a non-empty SessionId, so we synthesise
// a transient one when the user hasn't picked anything from the Sessions
// tab yet — this gives the bridge a stable bucket to write the live
// transcript into without persisting across runs.
func finalSessionID(active, fallbackSeed string) string {
	if active != "" {
		return active
	}
	// Stable per-process id so retries within a TUI session land on the
	// same bridge-side stream slot. fallbackSeed comes from the chat
	// model (typically the start time in millis) so the id is unique
	// across processes.
	if fallbackSeed != "" {
		return "tui-" + strings.TrimSpace(fallbackSeed)
	}
	return "tui-ephemeral"
}

// loadChatSession GETs /v1/sessions/<id> and dispatches a
// chatSessionLoadedMsg with the parsed history. Mirrors the web
// frontend's "click session, see full transcript" flow.
func loadChatSession(c *http.Client, base string, opts Options, id string) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		if listOpts.Timeout > 30*time.Second || listOpts.Timeout <= 0 {
			listOpts.Timeout = 30 * time.Second
		}
		body, status, err := jsonGET(c, base, "/v1/sessions/"+id, listOpts)
		if err != nil {
			return chatSessionLoadedMsg{id: id, err: err.Error()}
		}
		if status >= 300 {
			return chatSessionLoadedMsg{id: id, err: fmt.Sprintf("HTTP %d", status)}
		}
		name, cwd, turns, perr := parseSessionTurns(body)
		if perr != nil {
			return chatSessionLoadedMsg{id: id, err: "parse: " + perr.Error()}
		}
		return chatSessionLoadedMsg{
			id:         id,
			name:       name,
			workingDir: cwd,
			turns:      turns,
		}
	}
}

// parseSessionTurns flattens the bridge's session JSON into the local
// `turn` shape the chat panel renders. The bridge stores messages as
// either {role, text} or {role, blocks:[{type, content|name|id|...}]};
// we accept both and fan blocks out into one turn each so the existing
// renderer (refreshTranscript) handles the styling.
func parseSessionTurns(raw []byte) (name, cwd string, turns []turn, err error) {
	var p struct {
		Session struct {
			Name       string `json:"name"`
			WorkingDir string `json:"workingDir"`
			Messages   []struct {
				Role   string          `json:"role"`
				Text   any             `json:"text"`
				Blocks []messageBlock  `json:"blocks"`
			} `json:"messages"`
		} `json:"session"`
	}
	if err = json.Unmarshal(raw, &p); err != nil {
		return "", "", nil, err
	}
	for _, mm := range p.Session.Messages {
		// Plain {role, text} — single turn.
		if t, ok := mm.Text.(string); ok && t != "" {
			turns = append(turns, turn{role: mm.Role, text: t})
			continue
		}
		// Block array — fan out by type.
		for _, blk := range mm.Blocks {
			turns = append(turns, blockToTurn(mm.Role, blk))
		}
	}
	return p.Session.Name, p.Session.WorkingDir, turns, nil
}

// messageBlock mirrors the bridge's structured-message block shape.
// Tool args / results may carry either `content` (text) or `input` /
// `output` objects — we render whatever's there as a string.
type messageBlock struct {
	Type    string         `json:"type"`
	Content string         `json:"content"`
	Text    string         `json:"text"`
	Name    string         `json:"name"`
	Tool    string         `json:"tool"`
	ID      string         `json:"id"`
	Input   map[string]any `json:"input"`
	Output  any            `json:"output"`
	OK      *bool          `json:"ok"`
	Error   string         `json:"error"`
}

func blockToTurn(role string, b messageBlock) turn {
	switch b.Type {
	case "text", "":
		txt := b.Content
		if txt == "" {
			txt = b.Text
		}
		return turn{role: role, text: txt}
	case "tool_use", "toolUse", "tool-call":
		name := b.Name
		if name == "" {
			name = b.Tool
		}
		args := summariseToolArgs(b.Input)
		return turn{role: "tool", text: fmt.Sprintf("[tool: %s] %s", name, args), toolID: b.ID}
	case "tool_result", "toolResult":
		ok := true
		if b.OK != nil {
			ok = *b.OK
		}
		body := b.Content
		if body == "" {
			body = b.Text
		}
		if body == "" && b.Output != nil {
			if s, isString := b.Output.(string); isString {
				body = s
			} else {
				if bb, mErr := json.Marshal(b.Output); mErr == nil {
					body = string(bb)
				}
			}
		}
		return turn{role: "tool_result", text: body, toolID: b.ID, toolOK: ok, toolErr: b.Error}
	case "btw":
		return turn{role: "system", text: "↪ btw: " + b.Text}
	case "note":
		return turn{role: "system", text: "✎ note: " + b.Text}
	default:
		return turn{role: "system", text: fmt.Sprintf("(%s block)", b.Type)}
	}
}

// getStream issues an SSE-friendly GET (no body, no timeout) so a
// long-lived stream like /v1/sessions/<id>/stream can stay open
// without the request context cancelling it. Caller is responsible
// for closing resp.Body when the stream ends or via cancel().
func getStream(c *http.Client, base string, opts Options, path string) (*http.Response, context.CancelFunc, error) {
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", base+path, nil)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	req.Header.Set("Accept", "text/event-stream, application/json")
	authHeader(req, opts)
	resp, err := c.Do(req)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	return resp, cancel, nil
}

// sendBtw POSTs a "by the way" message to a running stream so the
// assistant can react mid-response. Bridge route:
// POST /v1/sessions/<id>/btw  body: {text: "..."}
// Returns a fire-and-forget tea.Cmd — failures are swallowed because
// btw is best-effort by design (no UI affordance for retries).
func sendBtw(c *http.Client, base string, opts Options, sessionID, body string) tea.Cmd {
	return func() tea.Msg {
		if sessionID == "" {
			return nil
		}
		buf, _ := json.Marshal(map[string]string{"text": body})
		req, err := http.NewRequest("POST",
			base+"/v1/sessions/"+sessionID+"/btw", strings.NewReader(string(buf)))
		if err != nil {
			return nil
		}
		req.Header.Set("Content-Type", "application/json")
		applyAuthHeader(req, opts)
		resp, err := c.Do(req)
		if err != nil {
			return nil
		}
		_ = resp.Body.Close()
		return nil
	}
}

// applyAuthHeader is a thin wrapper around app.go's authHeader so wire.go
// can stamp bearer auth without cross-file imports.
func applyAuthHeader(req *http.Request, opts Options) {
	authHeader(req, opts)
}

// readNextChunk turns the stream channel into a tea.Cmd. We re-issue it
// from chat.Update() after every chunkMsg so the bubbletea loop keeps
// consuming until the pump closes the channel.
func readNextChunk(ch chan chunkMsg) tea.Cmd {
	return func() tea.Msg {
		c, ok := <-ch
		if !ok {
			// Channel closed without an explicit terminator — synthesise one.
			return chunkMsg{end: true}
		}
		return c
	}
}

// pumpSSE consumes the response body, emits chunkMsg events onto ch
// and closes ch when finished. Runs in its own goroutine.
func pumpSSE(resp *http.Response, id int, ch chan<- chunkMsg) {
	defer resp.Body.Close()
	defer close(ch)

	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		hint := authHint(resp.StatusCode)
		msg := fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		if hint != "" {
			msg = msg + "  →  " + hint
		}
		ch <- chunkMsg{streamID: id, transport: msg, end: true}
		return
	}

	br := bufio.NewReader(resp.Body)
	var dataBuf strings.Builder
	flush := func() {
		if dataBuf.Len() == 0 {
			return
		}
		raw := dataBuf.String()
		dataBuf.Reset()
		// /v1/stream/ closes with a literal `[DONE]` sentinel after the
		// final JSON chunk. /v1/stream-direct/ uses a `{"type":"done"}`
		// chunk. Treat both as terminators.
		if strings.TrimSpace(raw) == "[DONE]" {
			ch <- chunkMsg{streamID: id, end: true}
			return
		}
		var c ssEChunk
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			// Malformed frame: drop silently so a noisy stream doesn't
			// nuke the chat.
			return
		}
		// Filter heartbeats — the bridge sends `{"_hb":<ms>}` every 10s.
		if c.HB != 0 && c.Type == "" && c.Text == "" && c.Delta == "" &&
			c.Reasoning == "" && c.ToolUse == nil && c.ToolResult == nil &&
			c.Error == "" {
			return
		}
		ch <- chunkMsg{streamID: id, chunk: c}
		if c.Type == "done" || c.Type == "error" || c.Error != "" {
			ch <- chunkMsg{streamID: id, end: true}
		}
	}
	for {
		line, err := br.ReadString('\n')
		if errors.Is(err, io.EOF) {
			flush()
			break
		}
		if err != nil {
			ch <- chunkMsg{streamID: id, transport: err.Error(), end: true}
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimPrefix(line, "data:")
			payload = strings.TrimPrefix(payload, " ")
			if dataBuf.Len() > 0 {
				dataBuf.WriteByte('\n')
			}
			dataBuf.WriteString(payload)
		}
	}
	ch <- chunkMsg{streamID: id, end: true}
}

// authHint returns an actionable hint for HTTP failures the user is
// likely to bump into. Empty string when the status doesn't have a
// well-known fix.
func authHint(status int) string {
	switch status {
	case 401:
		return "set YHA_BEARER_TOKEN in bridge/.env (then ./yha.sh dev) and pass --token=$YHA_BEARER_TOKEN to yha tui"
	case 403:
		return "your email isn't on ALLOWED_EMAILS, or token mismatch"
	case 503:
		return "no API key configured for this provider — check bridge/.env (e.g. ANTHROPIC_API_KEY)"
	}
	return ""
}

// summariseToolArgs renders a one-line preview of tool args for the
// transcript box. Keeps the chat panel readable when an assistant
// emits deeply-nested input objects.
func summariseToolArgs(args map[string]any) string {
	if len(args) == 0 {
		return ""
	}
	if cmd, ok := args["command"].(string); ok && cmd != "" {
		return truncate(cmd, 80)
	}
	b, err := json.Marshal(args)
	if err != nil {
		return ""
	}
	return truncate(string(b), 80)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-3] + "..."
}
