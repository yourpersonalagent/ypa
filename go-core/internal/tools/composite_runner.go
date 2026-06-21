// CompositeRunner fans tool calls across three dispatch backends:
//
//   - Embedded MCP server — the six bridge-native built-ins (Bash, Read,
//     Write, Glob, Grep, WebFetch). In-process, no subprocess.
//   - MCP pool — every tool advertised by a running MCP child server.
//     Name collisions across servers get prefixed `<safe_server>__`.
//   - Node-callback runner — module-provided tools whose handlers live
//     in Node (AskUser, RunCode, Task, etc.). Reached via POST
//     /proxy/tool with the bridge key.
//
// The composite's dispatch map is built lazily on the first Catalog()
// call and refreshed on every subsequent one. Run() looks up the source
// in the map; on a miss it invalidates the Node-catalog cache and tries
// one more refresh before reporting "unknown tool". That covers the
// case where Node enabled a module mid-session and the model knew the
// name from a prefs-tab description rather than the catalog the loop
// last advertised.
//
// Construct via NewCompositeRunner. Safe for concurrent use; the map
// has its own mutex so Run() and Catalog() don't serialise.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// EmbeddedMCP is the surface the composite runner needs from the
// in-process MCP server in internal/embeddedmcp. The interface is
// declared in terms of *Result directly so the implementation owns
// the MCP→Runner translation; this also keeps internal/tools free of
// any internal/embeddedmcp import (which would close a package cycle).
type EmbeddedMCP interface {
	CallTool(ctx context.Context, name string, args map[string]any) (*Result, error)
	ListTools() []EmbeddedMCPTool
}

// EmbeddedMCPTool mirrors embeddedmcp.ToolDef in shape; defined locally
// to avoid the package cycle.
type EmbeddedMCPTool struct {
	Name        string
	Description string
	InputSchema map[string]any
}

// MCPPool is the surface the composite runner needs from internal/mcp's
// Pool. Tightening the type here keeps internal/tools dependency-free
// and lets tests pass a fake pool.
type MCPPool interface {
	// List returns every Connection currently in the pool.
	List() []MCPConnection
}

// MCPConnection is the surface the composite needs from one Pool
// Connection. Just enough to enumerate tools, identify the server, and
// invoke a tool by name. The real *mcp.Connection satisfies this via
// adapters in main; pool_adapter.go below wraps the live concrete type.
type MCPConnection interface {
	ServerName() string
	Tools() []MCPTool
	CallTool(ctx context.Context, toolName string, args map[string]any) (map[string]any, error)
}

// NodeCatalogClient fetches the module-provided tool list from the Node
// bridge. The composite calls Get on each Catalog() refresh and
// Invalidate when a Run() dispatch misses.
type NodeCatalogClient interface {
	Get(ctx context.Context) ([]Tool, error)
	Invalidate()
}

// NodeRunner posts /proxy/tool on the Node bridge for module-served
// tools. cwd + sessionID flow through so AskUser-style prompts can
// attach to the right session and RunCode lands in the right cwd.
type NodeRunner interface {
	Run(ctx context.Context, name string, args map[string]any, cwd, sessionID string) (*Result, error)
}

// dispatchEntry tells the composite which backend owns a tool. The
// Original field carries the un-prefixed name we need to pass to the
// pool's CallTool — the model sees the prefixed name (alpha__ping) but
// the server only knows `ping`.
type dispatchEntry struct {
	source   string // "builtin" | "mcp:<server>" | "node"
	original string // un-prefixed name passed to the underlying call
}

// CompositeRunner satisfies the Runner interface by routing tool calls
// to whichever backend owns the name. Construct via NewCompositeRunner.
type CompositeRunner struct {
	embedded EmbeddedMCP
	pool     MCPPool
	catalog  NodeCatalogClient
	node     NodeRunner

	// Per-call context for Catalog() / Run() — typically the request's
	// own ctx. The map is populated on each Catalog() call.
	mu       sync.RWMutex
	dispatch map[string]dispatchEntry

	// cwd + sessionID flow through Run when the user request includes
	// them; they're attached via WithSession before the runner is
	// handed to stream.Run.
	cwd       string
	sessionID string
}

// NewCompositeRunner wires the four backends together. All four
// arguments are optional (nil means "no tools from that source") but
// at least one should be non-nil for the runner to be useful.
func NewCompositeRunner(embedded EmbeddedMCP, pool MCPPool, catalog NodeCatalogClient, node NodeRunner) *CompositeRunner {
	return &CompositeRunner{
		embedded: embedded,
		pool:     pool,
		catalog:  catalog,
		node:     node,
		dispatch: map[string]dispatchEntry{},
	}
}

// WithSession returns a CompositeRunner whose Run calls carry the
// supplied cwd / sessionID through to the Node-callback runner. The
// receiver isn't mutated — the route handler creates a per-request
// view and drops it when the request finishes. The dispatch map is
// shared (read-only from the perspective of WithSession).
func (c *CompositeRunner) WithSession(cwd, sessionID string) *CompositeRunner {
	if c == nil {
		return nil
	}
	return &CompositeRunner{
		embedded:  c.embedded,
		pool:      c.pool,
		catalog:   c.catalog,
		node:      c.node,
		dispatch:  c.dispatch,
		mu:        sync.RWMutex{}, // not shared — see note below
		cwd:       cwd,
		sessionID: sessionID,
	}
}

// Catalog assembles the merged tool list and refreshes the dispatch
// map. Order: built-ins first, then MCP-pool tools (with collision
// prefixing), then Node-module tools. Names collide between layers
// (builtin > mcp > node) — first writer wins. This mirrors the JS
// catalog's precedence so a Node-overridden Bash never shadows the
// Go-native one.
func (c *CompositeRunner) Catalog() []Tool {
	out := []Tool{}
	dispatch := map[string]dispatchEntry{}

	// 1. Built-ins.
	if c.embedded != nil {
		for _, t := range c.embedded.ListTools() {
			out = append(out, Tool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.InputSchema,
				Source:      "bridge",
			})
			dispatch[t.Name] = dispatchEntry{source: "builtin", original: t.Name}
		}
	}

	// 2. MCP pool tools, with collision-aware prefixing.
	if c.pool != nil {
		conns := c.pool.List()
		nameCount := map[string]int{}
		for _, conn := range conns {
			for _, t := range conn.Tools() {
				nameCount[t.Name]++
			}
		}
		for _, conn := range conns {
			safePrefix := nameSafeRE.ReplaceAllString(conn.ServerName(), "_") + "__"
			for _, t := range conn.Tools() {
				exposed := t.Name
				if nameCount[t.Name] > 1 {
					exposed = safePrefix + t.Name
				}
				if _, taken := dispatch[exposed]; taken {
					continue // builtin shadows
				}
				out = append(out, MCPSource(conn.ServerName(), MCPTool{
					Name:        t.Name,
					Description: t.Description,
					InputSchema: t.InputSchema,
				}))
				// Rename the most-recently-appended tool to the prefixed form.
				out[len(out)-1].Name = exposed
				dispatch[exposed] = dispatchEntry{
					source:   "mcp:" + conn.ServerName(),
					original: t.Name,
				}
			}
		}
	}

	// 3. Node-module tools. We use a short ctx tied to the runner's
	// stored cwd-ctx — but Catalog() doesn't take one, so we let the
	// Node client fall back to its own internal timeout via a
	// Background() context. The client's cache will hide the network
	// cost on the hot path.
	if c.catalog != nil {
		nodeTools, err := c.catalog.Get(context.Background())
		if err == nil {
			for _, t := range nodeTools {
				if _, taken := dispatch[t.Name]; taken {
					continue
				}
				src := t.Source
				if src == "" {
					src = "node"
				}
				out = append(out, Tool{
					Name:        t.Name,
					Description: t.Description,
					InputSchema: t.InputSchema,
					Source:      src,
				})
				dispatch[t.Name] = dispatchEntry{source: "node", original: t.Name}
			}
		}
	}

	c.mu.Lock()
	c.dispatch = dispatch
	c.mu.Unlock()
	return out
}

// Run dispatches a tool by name. On a miss it invalidates the Node
// catalog cache and rebuilds the dispatch map once before giving up.
// Returning an OK=false Result (rather than an error) keeps the model
// in a position to recover.
func (c *CompositeRunner) Run(ctx context.Context, name string, args map[string]any) (*Result, error) {
	entry, ok := c.lookup(name)
	if !ok {
		// One refresh — maybe Node enabled a module since our last
		// Catalog() call. If still missing, give up cleanly.
		if c.catalog != nil {
			c.catalog.Invalidate()
		}
		_ = c.Catalog()
		entry, ok = c.lookup(name)
		if !ok {
			return &Result{
				OK:    false,
				Error: fmt.Sprintf("unknown tool: %s", name),
			}, nil
		}
	}

	switch {
	case entry.source == "builtin":
		if c.embedded == nil {
			return &Result{OK: false, Error: "no embedded MCP server configured"}, nil
		}
		res, err := c.embedded.CallTool(ctx, entry.original, args)
		if err != nil {
			if res != nil {
				return res, nil
			}
			return &Result{OK: false, Error: err.Error()}, nil
		}
		return res, nil

	case strings.HasPrefix(entry.source, "mcp:"):
		serverName := strings.TrimPrefix(entry.source, "mcp:")
		if c.pool == nil {
			return &Result{OK: false, Error: "no MCP pool configured"}, nil
		}
		conn := findConn(c.pool.List(), serverName)
		if conn == nil {
			return &Result{
				OK:    false,
				Error: fmt.Sprintf("MCP server %q no longer running", serverName),
			}, nil
		}
		raw, err := conn.CallTool(ctx, entry.original, args)
		if err != nil {
			return &Result{OK: false, Error: err.Error()}, nil
		}
		return mcpResultToRunnerResult(raw), nil

	case entry.source == "node":
		if c.node == nil {
			return &Result{OK: false, Error: "no Node runner configured"}, nil
		}
		return c.node.Run(ctx, entry.original, args, c.cwd, c.sessionID)

	default:
		return &Result{
			OK:    false,
			Error: fmt.Sprintf("composite: unknown dispatch source %q", entry.source),
		}, nil
	}
}

// lookup is a tiny read-locked accessor. Run() calls it twice per
// dispatch in the cold path (refresh on miss).
func (c *CompositeRunner) lookup(name string) (dispatchEntry, bool) {
	c.mu.RLock()
	e, ok := c.dispatch[name]
	c.mu.RUnlock()
	return e, ok
}

// findConn walks the pool's snapshot for a server with the given name.
// Returns nil if the server is no longer in the pool — typical race
// after a /v1/mcp/stop landed mid-stream.
func findConn(conns []MCPConnection, name string) MCPConnection {
	for _, c := range conns {
		if c.ServerName() == name {
			return c
		}
	}
	return nil
}

// mcpResultToRunnerResult unwraps an MCP tools/call response into a
// *Result. The MCP shape is {content: [{type: "text", text: "..."}],
// isError?: bool}; we flatten the text blocks into Content and let
// the boolean drive OK.
func mcpResultToRunnerResult(raw map[string]any) *Result {
	if raw == nil {
		return &Result{OK: false, Error: "empty MCP response"}
	}
	isError, _ := raw["isError"].(bool)
	text := flattenMCPContent(raw["content"])
	out := &Result{OK: !isError, Content: text}
	if isError {
		out.Error = text
	}
	return out
}

// flattenMCPContent walks the content array of an MCP tools/call
// response and concatenates the text blocks. Non-text blocks (image,
// resource) are JSON-serialised back into the output so the model can
// still react to them, even if it can't render. Falls back to a
// JSON dump of the whole field when the structure is unexpected.
func flattenMCPContent(content any) string {
	blocks, ok := content.([]any)
	if !ok {
		if content == nil {
			return ""
		}
		b, _ := json.Marshal(content)
		return string(b)
	}
	var sb strings.Builder
	for _, b := range blocks {
		m, ok := b.(map[string]any)
		if !ok {
			continue
		}
		t, _ := m["type"].(string)
		if t == "text" {
			if txt, ok := m["text"].(string); ok {
				sb.WriteString(txt)
				continue
			}
		}
		// Anything else: emit a JSON serialisation so the model sees something.
		j, _ := json.Marshal(m)
		sb.Write(j)
	}
	return sb.String()
}
