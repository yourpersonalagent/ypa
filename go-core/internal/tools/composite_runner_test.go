package tools

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
)

// ── Fakes for the four backend interfaces ─────────────────────────────────

type fakeEmbedded struct {
	tools  []EmbeddedMCPTool
	called int32
	last   string
}

func (f *fakeEmbedded) ListTools() []EmbeddedMCPTool { return f.tools }
func (f *fakeEmbedded) CallTool(_ context.Context, name string, _ map[string]any) (*Result, error) {
	atomic.AddInt32(&f.called, 1)
	f.last = name
	return &Result{OK: true, Content: "builtin:" + name}, nil
}

type fakePool struct {
	conns []MCPConnection
}

func (f *fakePool) List() []MCPConnection { return f.conns }

type fakeConn struct {
	name   string
	tools  []MCPTool
	called int32
	last   string
}

func (c *fakeConn) ServerName() string { return c.name }
func (c *fakeConn) Tools() []MCPTool   { return c.tools }
func (c *fakeConn) CallTool(_ context.Context, toolName string, _ map[string]any) (map[string]any, error) {
	atomic.AddInt32(&c.called, 1)
	c.last = toolName
	return map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": "mcp:" + c.name + ":" + toolName},
		},
	}, nil
}

type fakeCatalog struct {
	tools       []Tool
	getCalls    int32
	invalidated int32
	failNext    bool
}

func (c *fakeCatalog) Get(_ context.Context) ([]Tool, error) {
	atomic.AddInt32(&c.getCalls, 1)
	if c.failNext {
		c.failNext = false
		return nil, errors.New("simulated failure")
	}
	return c.tools, nil
}
func (c *fakeCatalog) Invalidate() { atomic.AddInt32(&c.invalidated, 1) }

type fakeNode struct {
	called    int32
	lastName  string
	lastCwd   string
	lastSID   string
	returnRes *Result
}

func (n *fakeNode) Run(_ context.Context, name string, _ map[string]any, cwd, sessionID string) (*Result, error) {
	atomic.AddInt32(&n.called, 1)
	n.lastName = name
	n.lastCwd = cwd
	n.lastSID = sessionID
	if n.returnRes != nil {
		return n.returnRes, nil
	}
	return &Result{OK: true, Content: "node:" + name}, nil
}

// ── Tests ─────────────────────────────────────────────────────────────────

func newComposite() (*CompositeRunner, *fakeEmbedded, *fakePool, *fakeCatalog, *fakeNode) {
	emb := &fakeEmbedded{
		tools: []EmbeddedMCPTool{
			{Name: "Bash", Description: "run shell"},
			{Name: "Read", Description: "read file"},
		},
	}
	conn := &fakeConn{
		name: "websearch",
		tools: []MCPTool{
			{Name: "WebSearch", Description: "search the web"},
		},
	}
	pool := &fakePool{conns: []MCPConnection{conn}}
	cat := &fakeCatalog{
		tools: []Tool{
			{Name: "AskUser", Description: "ask the user", Source: "node:bridge"},
		},
	}
	node := &fakeNode{}
	return NewCompositeRunner(emb, pool, cat, node), emb, pool, cat, node
}

func TestCatalogAssemblesAllSources(t *testing.T) {
	c, _, _, _, _ := newComposite()
	got := c.Catalog()
	names := map[string]string{}
	for _, t := range got {
		names[t.Name] = t.Source
	}
	if names["Bash"] != "bridge" || names["Read"] != "bridge" {
		t.Errorf("builtins missing or wrong source: %v", names)
	}
	if names["WebSearch"] != "mcp:websearch" {
		t.Errorf("MCP tool source = %q, want mcp:websearch", names["WebSearch"])
	}
	if names["AskUser"] == "" {
		t.Errorf("node tool missing: %v", names)
	}
}

func TestRunRoutesToBuiltin(t *testing.T) {
	c, emb, _, _, node := newComposite()
	_ = c.Catalog() // populate dispatch
	res, err := c.Run(context.Background(), "Bash", map[string]any{"command": "ls"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || !strings.HasPrefix(res.Content, "builtin:Bash") {
		t.Errorf("expected builtin dispatch, got %+v", res)
	}
	if emb.called != 1 {
		t.Errorf("embedded called = %d, want 1", emb.called)
	}
	if node.called != 0 {
		t.Errorf("node should not be called for builtin, got %d", node.called)
	}
}

func TestRunRoutesToMCPPool(t *testing.T) {
	c, _, _, _, _ := newComposite()
	_ = c.Catalog()
	res, err := c.Run(context.Background(), "WebSearch", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	if !strings.Contains(res.Content, "mcp:websearch:WebSearch") {
		t.Errorf("content = %q", res.Content)
	}
}

func TestRunRoutesToNode(t *testing.T) {
	c, _, _, _, node := newComposite()
	_ = c.Catalog()
	c2 := c.WithSession("/tmp/sess", "sid-7")
	res, err := c2.Run(context.Background(), "AskUser", map[string]any{"q": "?"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	if node.lastName != "AskUser" || node.lastCwd != "/tmp/sess" || node.lastSID != "sid-7" {
		t.Errorf("node received name=%q cwd=%q sid=%q",
			node.lastName, node.lastCwd, node.lastSID)
	}
}

func TestRunUnknownTriggersOneRefresh(t *testing.T) {
	c, _, _, cat, _ := newComposite()
	_ = c.Catalog()
	if got := atomic.LoadInt32(&cat.getCalls); got != 1 {
		t.Fatalf("initial Catalog calls = %d, want 1", got)
	}
	// Model asks for a tool name we don't have. Expect ONE invalidate +
	// refresh, then an "unknown tool" result.
	res, err := c.Run(context.Background(), "TotallyMissing", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.OK {
		t.Error("expected OK=false for unknown tool")
	}
	if !strings.Contains(res.Error, "unknown tool") {
		t.Errorf("Error = %q", res.Error)
	}
	if got := atomic.LoadInt32(&cat.invalidated); got != 1 {
		t.Errorf("invalidate calls = %d, want 1", got)
	}
}

func TestRunUnknownRefreshFindsIt(t *testing.T) {
	c, _, _, cat, _ := newComposite()
	_ = c.Catalog()
	// Inject a new tool name. The Run() miss path should call
	// Invalidate, then re-fetch via Get, and find it on the second
	// dispatch lookup.
	cat.tools = append(cat.tools, Tool{Name: "FreshlyAdded", Source: "node:bridge"})
	res, err := c.Run(context.Background(), "FreshlyAdded", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Errorf("expected refresh to pick up new tool, got %+v", res)
	}
}

func TestCatalogBuiltinShadowsNode(t *testing.T) {
	// If Node advertises a tool with the same name as a built-in, the
	// built-in wins. Mirrors the JS catalog's precedence so a Node
	// surprise can't shadow Bash mid-stream.
	emb := &fakeEmbedded{
		tools: []EmbeddedMCPTool{{Name: "Bash"}},
	}
	cat := &fakeCatalog{
		tools: []Tool{{Name: "Bash", Source: "node:hijack"}},
	}
	c := NewCompositeRunner(emb, nil, cat, nil)
	got := c.Catalog()
	sources := map[string]string{}
	for _, t := range got {
		sources[t.Name] = t.Source
	}
	if sources["Bash"] != "bridge" {
		t.Errorf("Bash source = %q, want bridge (built-in shadow)", sources["Bash"])
	}
	if len(got) != 1 {
		t.Errorf("expected 1 tool, got %d (%+v)", len(got), got)
	}
}

func TestCatalogMCPPrefixOnCollision(t *testing.T) {
	emb := &fakeEmbedded{}
	conn1 := &fakeConn{name: "alpha", tools: []MCPTool{{Name: "ping"}}}
	conn2 := &fakeConn{name: "beta-srv", tools: []MCPTool{{Name: "ping"}}}
	c := NewCompositeRunner(emb, &fakePool{conns: []MCPConnection{conn1, conn2}}, nil, nil)
	got := c.Catalog()
	names := map[string]bool{}
	for _, t := range got {
		names[t.Name] = true
	}
	if !names["alpha__ping"] || !names["beta_srv__ping"] {
		t.Errorf("expected prefixed colliding names, got %v", names)
	}
}

func TestCatalogMCPPrefixDispatch(t *testing.T) {
	emb := &fakeEmbedded{}
	conn := &fakeConn{name: "alpha", tools: []MCPTool{{Name: "ping"}}}
	conn2 := &fakeConn{name: "beta", tools: []MCPTool{{Name: "ping"}}}
	c := NewCompositeRunner(emb, &fakePool{conns: []MCPConnection{conn, conn2}}, nil, nil)
	_ = c.Catalog()
	// The model sees "alpha__ping" — Run() must un-prefix back to "ping"
	// when calling the underlying connection.
	_, err := c.Run(context.Background(), "alpha__ping", nil)
	if err != nil {
		t.Fatal(err)
	}
	if conn.last != "ping" {
		t.Errorf("conn.alpha last = %q, want 'ping' (un-prefixed)", conn.last)
	}
	if conn2.called != 0 {
		t.Errorf("beta conn unexpectedly called %d times", conn2.called)
	}
}

func TestRunNoBackendsConfiguredGivesCleanError(t *testing.T) {
	c := NewCompositeRunner(nil, nil, nil, nil)
	_ = c.Catalog()
	res, err := c.Run(context.Background(), "X", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.OK {
		t.Error("expected OK=false")
	}
}

func TestFlattenMCPContentTextOnly(t *testing.T) {
	got := flattenMCPContent([]any{
		map[string]any{"type": "text", "text": "hello "},
		map[string]any{"type": "text", "text": "world"},
	})
	if got != "hello world" {
		t.Errorf("got %q", got)
	}
}

func TestFlattenMCPContentMixedBlock(t *testing.T) {
	got := flattenMCPContent([]any{
		map[string]any{"type": "text", "text": "see: "},
		map[string]any{"type": "image", "url": "x.png"},
	})
	if !strings.HasPrefix(got, "see: ") {
		t.Errorf("got %q", got)
	}
	if !strings.Contains(got, "x.png") {
		t.Errorf("non-text block dropped: %q", got)
	}
}

func TestFlattenMCPContentNil(t *testing.T) {
	if got := flattenMCPContent(nil); got != "" {
		t.Errorf("nil content = %q, want empty", got)
	}
}

func TestExecutorImplementsRunner(t *testing.T) {
	// Compile-time check via interface assignment.
	var _ Runner = (*Executor)(nil)
	var _ Runner = (*CompositeRunner)(nil)
}
