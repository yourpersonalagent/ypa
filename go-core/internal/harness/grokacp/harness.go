package grokacp

// harness.go — adapter wiring the ACP client into the framework's
// harness.Harness (like claudesdk/harness.go and grokbuild/harness.go).
//
// This lets the "grok-acp" label be a first-class peer to "grok"
// (headless binary) and "claude-sdk" / "claude-binary".

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"sync"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/stream"
)

var errUnconfigured = errors.New("grokacp.Harness: client unconfigured")

// HarnessOpts for NewHarness.
type HarnessOpts struct {
	Binary   string
	Logger   *logger.Logger
	History  *harness.History // for ACP sessionId roundtrip under "grok-acp"
	Active   *harness.ActiveProcesses
	Resolver InstanceResolver // for HOME per GrokInstance
}

// InstanceResolver same shape as grokbuild so wiring can reuse the one it builds.
type InstanceResolver interface {
	Resolve(id string) (homeDir string, ok bool)
}

// Harness implements harness.Harness for the ACP route.
type Harness struct {
	client        *ClientManager
	hist          *harness.History
	active        *harness.ActiveProcesses
	resolver      InstanceResolver
	log           *logger.Logger
	defaultBinary string
}

// ClientManager keeps one long-lived `grok agent stdio` Client per GrokInstance (by home).
type ClientManager struct {
	mu      sync.Mutex
	clients map[string]*Client
	log     *logger.Logger
	binary  string
}

func NewClientManager(binary string, log *logger.Logger) *ClientManager {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &ClientManager{
		clients: make(map[string]*Client),
		log:     log,
		binary:  binary,
	}
}

func (m *ClientManager) Get(ctx context.Context, home, cwd string) (*Client, error) {
	m.mu.Lock()
	key := home
	if key == "" {
		key = "default"
	}
	cl, ok := m.clients[key]
	if !ok {
		cl = newClient(m.binary, home, m.log)
		cl.cwd = cwd
		m.clients[key] = cl
	}
	m.mu.Unlock()

	if err := cl.Start(ctx); err != nil {
		return nil, err
	}
	return cl, nil
}

func (m *ClientManager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, cl := range m.clients {
		cl.Close()
	}
	m.clients = make(map[string]*Client)
}

// NewHarness returns a harness.Harness for the grok-acp route.
func NewHarness(opts HarnessOpts) *Harness {
	log := opts.Logger
	if log == nil {
		log = logger.New(io.Discard)
	}
	mgr := NewClientManager(opts.Binary, log)
	return &Harness{
		client:        mgr,
		hist:          opts.History,
		active:        opts.Active,
		resolver:      opts.Resolver,
		log:           log.With("harness", HarnessID),
		defaultBinary: opts.Binary,
	}
}

func (h *Harness) ID() string { return HarnessID }

func (h *Harness) Stream(ctx context.Context, req harness.Request, emit harness.Emit) (harness.Result, error) {
	if h == nil || h.client == nil {
		return harness.Result{Err: errUnconfigured}, errUnconfigured
	}
	if emit == nil {
		return harness.Result{Err: errors.New("emit required")}, errors.New("emit required")
	}

	// Resolve HOME for the GrokInstance (auth + materialized MCP config).
	home := ""
	if h.resolver != nil {
		if id := strings.TrimSpace(req.GrokInstance); id != "" {
			if d, ok := h.resolver.Resolve(id); ok {
				home = d
			}
		}
	}
	if home == "" && strings.ContainsAny(strings.TrimSpace(req.GrokInstance), `/\`) {
		home = normalizeHomeDir(req.GrokInstance)
	}

	prompt := assemblePromptForACP(req)

	cl, err := h.client.Get(ctx, home, req.CWD)
	if err != nil {
		emit(stream.Chunk{Type: stream.ChunkTypeError, Error: err.Error()})
		return harness.Result{Err: err}, err
	}

	// ACP session reuse (the "resume" for this route).
	acpKey := firstNonEmpty(req.HistorySessionID, req.SessionID)
	acpSID := ""
	if h.hist != nil && acpKey != "" {
		if v, ok := h.hist.Get(HarnessID, acpKey); ok && v != "" {
			acpSID = v
		}
	}
	if acpSID == "" {
		sid, err := cl.NewSession(ctx, req.CWD)
		if err != nil {
			return harness.Result{Err: err}, err
		}
		acpSID = sid
		if h.hist != nil && acpKey != "" {
			_ = h.hist.Set(HarnessID, acpKey, acpSID)
		}
	}

	// Stop integration.
	if h.active != nil && req.SessionID != "" {
		cancelCtx, cancel := context.WithCancel(ctx)
		ctx = cancelCtx
		h.active.Register(req.SessionID, func() { cancel() })
		defer h.active.Drop(req.SessionID)
	}

	res, err := cl.Prompt(ctx, acpSID, prompt, emit)
	if err != nil {
		emit(stream.Chunk{Type: stream.ChunkTypeError, Error: err.Error()})
		if acpKey != "" && h.hist != nil {
			// Clear a bad ACP session id on failure so the next turn for this
			// YHA session gets a fresh one instead of re-trying a dead agent sess
			// (parallel to the grokbuild --resume poison clearing).
			_ = h.hist.Delete(HarnessID, acpKey)
		}
		return harness.Result{Err: err}, err
	}

	if res.SessionID != "" && h.hist != nil && acpKey != "" {
		_ = h.hist.Set(HarnessID, acpKey, res.SessionID)
	}

	out := harness.Result{
		Text:       res.Text,
		StopReason: normalizeStop(res.StopReason),
		Usage: harness.Usage{
			InputTokens:  res.InputTokens,
			OutputTokens: res.OutputTokens,
		},
	}
	if out.StopReason == "" {
		out.StopReason = "end_turn"
	}
	return out, nil
}

func normalizeHomeDir(dir string) string {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return ""
	}
	clean := filepath.Clean(dir)
	if strings.EqualFold(filepath.Base(clean), ".grok") {
		parent := filepath.Dir(clean)
		if parent != "." && parent != clean {
			return parent
		}
	}
	return dir
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func normalizeStop(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "", "end", "end_turn", "stop":
		return "end_turn"
	case "max_tokens", "maxtokens":
		return "max_tokens"
	case "tool_use", "tooluse":
		return "tool_use"
	}
	return s
}

// assemblePromptForACP keeps skills + advisory tool list visible to the agent.
func assemblePromptForACP(req harness.Request) string {
	prompt := req.Input
	if len(req.Skills) > 0 {
		var blocks []string
		for _, s := range req.Skills {
			if strings.TrimSpace(s.Name) == "" && strings.TrimSpace(s.Content) == "" {
				continue
			}
			blocks = append(blocks, "## Skill: "+s.Name+"\n\n"+s.Content)
		}
		if len(blocks) > 0 {
			prompt = strings.Join(blocks, "\n\n---\n\n") + "\n\n---\n\n" + prompt
		}
	}
	if len(req.AllowedTools) > 0 {
		pre := "Tool availability for this run:\nOnly use these tools if necessary: " + strings.Join(req.AllowedTools, ", ") +
			"\nIf you need a tool outside this list, stop and say which tool is missing."
		prompt = pre + "\n\n---\n\n" + prompt
	}
	return prompt
}
