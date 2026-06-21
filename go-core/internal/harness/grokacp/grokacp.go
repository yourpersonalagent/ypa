package grokacp

// grokacp — dedicated harness for the Grok Build "sdk" / agent route using
// the official Agent Client Protocol (`grok agent stdio`).
//
// This is the direct analog of claudesdk (vs claudebinary):
// - Long-lived `grok agent stdio` process per GrokInstance (HOME isolation).
// - JSON-RPC 2.0 over stdio for session management and streaming updates.
// - Session reuse: YHA stores the ACP sessionId (via harness.History under
//   "grok-acp" key) so follow-up prompts on the same agent process give the
//   Grok agent continuous memory (plans, tool state, compaction) without
//   per-turn respawn or lossy folds.
// - MCP: inherits from the materialized config.toml written by promoteMcpTools
//   for the instance (same as CLI; YHA_MCP_TOOL_ALIAS_MODE already set for grok).
// - Streaming: agent_message_chunk notifications are emitted live as
//   ChunkTypeDelta (and reasoning if we detect internal style in future).
// - Full parity with the "grok" (headless binary) route: same Request shape,
//   skills/preset assembly, CWD, effort, resume (via ACP sessionId), usage path,
//   stop, ActiveProcesses integration, etc.
//
// Selection: explicit HarnessInstance == "grok-acp" (or future signals),
// exactly like claude-sdk. See route_harness.go and the "grok-acp" entry
// in main.go HarnessAdapters.
//
// The "grok" label remains the stable default headless binary path
// (one-shot -p streaming-json + --resume). Both can coexist and are
// switchable per turn/employee/instance for different workflows
// (quick vs long-horizon agentic).

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/stream"
)

const HarnessID = "grok-acp"

// ACP protocol constants / shapes (from docs.x.ai + observed).
const (
	protocolVersion = 1
)

// rpcMessage is a minimal JSON-RPC 2.0 envelope (request, response, or notification).
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

// Client manages one long-lived `grok agent stdio` process for a GrokInstance
// (identified by its resolved HOME / config dir). It handles handshake once,
// session creation/reuse, and streaming prompt updates.
type Client struct {
	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	stdout      io.ReadCloser
	stderr      io.ReadCloser
	pending     map[int]chan *rpcMessage
	activeSIDs  map[string] /*acp session id*/ emitWrapper
	nextID      int
	log         *logger.Logger
	homeDir     string
	binary      string
	cwd         string // default for sessions
	initialized bool
	closed      bool
}

// emitWrapper wraps the harness emit + a text accumulator for the prompt result.
type emitWrapper struct {
	emit harness.Emit
	text *strings.Builder
	sid  string
}

func newClient(binary, homeDir string, log *logger.Logger) *Client {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &Client{
		pending:    make(map[int]chan *rpcMessage),
		activeSIDs: make(map[string]emitWrapper),
		log:        log.With("harness", HarnessID),
		binary:     binary,
		homeDir:    homeDir,
	}
}

// Start (or restart) the agent stdio process for this instance.
// Idempotent; safe to call multiple times.
func (c *Client) Start(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("grokacp client closed")
	}
	if c.cmd != nil && c.cmd.Process != nil {
		// already running
		return nil
	}
	return c.startLocked(ctx)
}

func (c *Client) startLocked(ctx context.Context) error {
	bin := c.binary
	if bin == "" {
		bin = "grok"
	}
	args := []string{"agent", "stdio", "--no-auto-update"}
	// Add other daemon-friendly flags if supported (no-alt-screen etc. are for TUI).
	cmd := exec.CommandContext(ctx, bin, args...)

	// HOME for auth isolation + config (MCP etc. materialized here).
	env := buildEnv(c.homeDir)
	cmd.Env = env

	if c.cwd != "" {
		cmd.Dir = c.cwd
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return err
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		return err
	}

	c.cmd = cmd
	c.stdin = stdin
	c.stdout = stdout
	c.stderr = stderr
	c.initialized = false

	// Drain stderr (best-effort logging).
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			c.log.Debug("grok-acp.stderr", "line", sc.Text())
		}
	}()

	// Reader goroutine for stdout (responses + notifications).
	go c.readLoop()

	// Perform handshake.
	if err := c.doInitializeAndAuth(ctx); err != nil {
		c.killLocked()
		return err
	}
	c.initialized = true
	c.log.Info("grok-acp agent started", "home", c.homeDir)
	return nil
}

func (c *Client) readLoop() {
	scanner := bufio.NewScanner(c.stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var msg rpcMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			c.log.Warn("grok-acp bad json line", "err", err)
			continue
		}
		c.handleMessage(&msg)
	}
	if err := scanner.Err(); err != nil {
		c.log.Warn("grok-acp stdout scan ended", "err", err)
	}
}

func (c *Client) handleMessage(msg *rpcMessage) {
	if msg.Method != "" {
		// Notification (e.g. session/update)
		if msg.Method == "session/update" {
			c.handleSessionUpdate(msg)
		}
		return
	}
	// Response
	id := 0
	switch v := msg.ID.(type) {
	case float64:
		id = int(v)
	case int:
		id = v
	}
	c.mu.Lock()
	ch, ok := c.pending[id]
	if ok {
		delete(c.pending, id)
	}
	c.mu.Unlock()
	if ok {
		select {
		case ch <- msg:
		default:
		}
	}
}

func (c *Client) handleSessionUpdate(msg *rpcMessage) {
	// Flexible parsing for Grok ACP updates.
	// We support at least the documented agent_message_chunk, plus common
	// extensions for reasoning/thinking and tool calls/results so that
	// the UI gets the same rich blocks (tool cards, collapsible thinking)
	// as claude-binary / codex / and the grok *headless-binary* route.
	var params struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		return
	}

	sid := params.SessionID
	if sid == "" {
		// try to extract from raw update if top level has it
		var u struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(params.Update, &u)
		sid = u.SessionID
	}

	c.mu.Lock()
	w, ok := c.activeSIDs[sid]
	c.mu.Unlock()
	if !ok || w.emit == nil {
		return
	}

	// Parse the update payload generously.
	var upd map[string]any
	if err := json.Unmarshal(params.Update, &upd); err != nil {
		return
	}

	sessionUpdate, _ := upd["sessionUpdate"].(string)
	content, _ := upd["content"].(map[string]any)

	// 1. Text / message chunks → Delta (and accumulate for final text)
	if sessionUpdate == "agent_message_chunk" || sessionUpdate == "message" {
		var text string
		if content != nil {
			if t, ok := content["text"].(string); ok {
				text = t
			}
		} else if t, ok := upd["text"].(string); ok {
			text = t
		}
		if text != "" {
			w.emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: text})
			if w.text != nil {
				w.text.WriteString(text)
			}
			return
		}
	}

	// 2. Thinking / reasoning / internal steps → ChunkTypeReasoning (collapsible in UI)
	if sessionUpdate == "thinking" || sessionUpdate == "agent_thinking" ||
		strings.Contains(sessionUpdate, "think") || strings.Contains(sessionUpdate, "reason") {
		var text string
		if content != nil {
			if t, ok := content["text"].(string); ok {
				text = t
			}
		} else if t, ok := upd["text"].(string); ok {
			text = t
		} else if t, ok := upd["thinking"].(string); ok {
			text = t
		}
		if text != "" {
			w.emit(stream.Chunk{Type: stream.ChunkTypeReasoning, Text: text})
			// do not accumulate into main text result for thinking
			return
		}
	}

	// 3. Tool calls → proper ChunkTypeToolUse so UI shows nice cards like Claude/Codex/grok-headless
	if tc, ok := upd["toolCall"].(map[string]any); ok || sessionUpdate == "tool_call" || sessionUpdate == "toolCall" {
		if tc == nil {
			tc, _ = upd["toolCall"].(map[string]any)
		}
		if tc != nil {
			id := ""
			if v, ok := tc["id"].(string); ok {
				id = v
			}
			name := ""
			if v, ok := tc["name"].(string); ok {
				name = v
			} else if v, ok := tc["tool"].(string); ok {
				name = v
			}
			input := map[string]any{}
			if args, ok := tc["input"].(map[string]any); ok {
				input = args
			} else if args, ok := tc["args"].(map[string]any); ok {
				input = args
			} else if raw, ok := tc["args"]; ok {
				if b, err := json.Marshal(raw); err == nil {
					input = map[string]any{"_raw": string(b)}
				}
			}
			if name != "" {
				if id == "" {
					id = "grok-acp-" + strings.ToLower(strings.ReplaceAll(name, " ", "-"))
				}
				w.emit(stream.Chunk{
					Type: stream.ChunkTypeToolUse,
					ToolUse: &stream.ToolUseChunk{
						ID:    id,
						Name:  name,
						Input: input,
					},
				})
				return
			}
		}
	}

	// 4. Tool results → ChunkTypeToolResult (matched by ID in blocks/rewind)
	if tr, ok := upd["toolResult"].(map[string]any); ok || sessionUpdate == "tool_result" || sessionUpdate == "toolResult" {
		if tr == nil {
			tr, _ = upd["toolResult"].(map[string]any)
		}
		if tr != nil {
			id := ""
			if v, ok := tr["id"].(string); ok {
				id = v
			} else if v, ok := tr["tool_use_id"].(string); ok {
				id = v
			}
			contentStr := ""
			if c, ok := tr["content"].(string); ok {
				contentStr = c
			} else if c, ok := tr["output"].(string); ok {
				contentStr = c
			} else if raw, ok := tr["content"]; ok {
				if b, err := json.Marshal(raw); err == nil {
					contentStr = string(b)
				}
			}
			w.emit(stream.Chunk{
				Type: stream.ChunkTypeToolResult,
				ToolResult: &stream.ToolResultChunk{
					ID:      id,
					OK:      true,
					Content: contentStr,
				},
			})
			return
		}
	}

	// Fallback: if there's any text at top level of update, emit as delta
	if t, ok := upd["text"].(string); ok && t != "" {
		w.emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: t})
		if w.text != nil {
			w.text.WriteString(t)
		}
	}
}

func (c *Client) doInitializeAndAuth(ctx context.Context) error {
	// initialize
	initParams := map[string]any{
		"protocolVersion": protocolVersion,
		"clientCapabilities": map[string]any{
			"fs":       map[string]any{"readTextFile": true, "writeTextFile": true},
			"terminal": true,
		},
	}
	initResp, err := c.request(ctx, "initialize", initParams)
	if err != nil {
		return fmt.Errorf("initialize: %w", err)
	}

	// Extract auth methods.
	var initResult struct {
		AuthMethods []struct {
			ID string `json:"id"`
		} `json:"authMethods"`
	}
	_ = json.Unmarshal(initResp.Result, &initResult)

	authMethods := map[string]bool{}
	for _, m := range initResult.AuthMethods {
		authMethods[m.ID] = true
	}

	// Choose method. Prefer xai.api_key if we have env, else cached_token.
	methodID := "cached_token"
	if os.Getenv("XAI_API_KEY") != "" && authMethods["xai.api_key"] {
		methodID = "xai.api_key"
	}

	authParams := map[string]any{
		"methodId": methodID,
		"_meta":    map[string]any{"headless": true},
	}
	if methodID == "xai.api_key" {
		authParams["apiKey"] = os.Getenv("XAI_API_KEY")
	}

	_, err = c.request(ctx, "authenticate", authParams)
	if err != nil {
		return fmt.Errorf("authenticate: %w", err)
	}
	return nil
}

// request sends a JSON-RPC request and waits for the response (or ctx done).
func (c *Client) request(ctx context.Context, method string, params any) (*rpcMessage, error) {
	c.mu.Lock()
	if c.stdin == nil {
		c.mu.Unlock()
		return nil, errors.New("grok-acp not started")
	}
	id := c.nextID
	c.nextID++
	ch := make(chan *rpcMessage, 1)
	c.pending[id] = ch
	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}
	data, _ := json.Marshal(req)
	_, err := c.stdin.Write(append(data, '\n'))
	c.mu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return nil, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

// NewSession creates a new ACP session (or returns existing if sid provided and valid).
// For YHA we usually create once per YHA session and reuse the sid.
func (c *Client) NewSession(ctx context.Context, cwd string) (string, error) {
	if err := c.Start(ctx); err != nil {
		return "", err
	}
	params := map[string]any{
		"cwd":        cwd,
		"mcpServers": []any{}, // rely on materialized config under HOME
	}
	resp, err := c.request(ctx, "session/new", params)
	if err != nil {
		return "", err
	}
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return "", err
	}
	return result.SessionID, nil
}

// Prompt sends a prompt on an existing ACP sessionId and streams updates via emit.
// It returns the final result (text, stop, usage if present).
func (c *Client) Prompt(ctx context.Context, acpSessionID, promptText string, emit harness.Emit) (ACPResult, error) {
	if err := c.Start(ctx); err != nil {
		return ACPResult{}, err
	}

	// Register active sid for live chunk emission from reader.
	var textBuf strings.Builder
	wrapper := emitWrapper{emit: emit, text: &textBuf, sid: acpSessionID}

	c.mu.Lock()
	c.activeSIDs[acpSessionID] = wrapper
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.activeSIDs, acpSessionID)
		c.mu.Unlock()
	}()

	params := map[string]any{
		"sessionId": acpSessionID,
		"prompt": []map[string]any{
			{"type": "text", "text": promptText},
		},
	}

	resp, err := c.request(ctx, "session/prompt", params)
	if err != nil {
		return ACPResult{}, err
	}

	var result struct {
		StopReason string `json:"stopReason"`
		// Usage may appear here or in updates in future builds.
		Usage struct {
			InputTokens  int `json:"inputTokens"`
			OutputTokens int `json:"outputTokens"`
		} `json:"usage"`
	}
	_ = json.Unmarshal(resp.Result, &result)

	return ACPResult{
		Text:         textBuf.String(),
		StopReason:   result.StopReason,
		SessionID:    acpSessionID,
		InputTokens:  int64(result.Usage.InputTokens),
		OutputTokens: int64(result.Usage.OutputTokens),
	}, nil
}

type ACPResult struct {
	Text         string
	StopReason   string
	SessionID    string
	InputTokens  int64
	OutputTokens int64
}

func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.killLocked()
	c.closed = true
}

func (c *Client) killLocked() {
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
		_ = c.cmd.Wait()
	}
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	c.cmd = nil
	c.stdin = nil
	c.stdout = nil
	c.stderr = nil
	c.pending = make(map[int]chan *rpcMessage)
	c.activeSIDs = make(map[string]emitWrapper)
}

// buildEnv mirrors the HOME override logic from grokbuild for instance isolation.
func buildEnv(home string) []string {
	base := os.Environ()
	if home == "" {
		return base
	}
	out := make([]string, 0, len(base)+2)
	seen := false
	for _, kv := range base {
		eq := strings.IndexByte(kv, '=')
		if eq < 0 {
			out = append(out, kv)
			continue
		}
		key := kv[:eq]
		if key == "HOME" || (runtime.GOOS == "windows" && strings.EqualFold(key, "USERPROFILE")) {
			out = append(out, key+"="+home)
			if key == "HOME" {
				seen = true
			}
			continue
		}
		out = append(out, kv)
	}
	if !seen {
		out = append(out, "HOME="+home)
	}
	if runtime.GOOS == "windows" {
		hasUserProfile := false
		for _, kv := range out {
			if eq := strings.IndexByte(kv, '='); eq >= 0 && strings.EqualFold(kv[:eq], "USERPROFILE") {
				hasUserProfile = true
				break
			}
		}
		if !hasUserProfile {
			out = append(out, "USERPROFILE="+home)
		}
	}
	return out
}
