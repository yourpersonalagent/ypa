// Package embeddedmcp exposes the six bridge-native tools (Bash, Read,
// Write, Glob, Grep, WebFetch) over the MCP JSON-RPC protocol — in
// process, no subprocess, no stdio. The point isn't IPC; it's protocol
// uniformity. The composite runner over in internal/tools can dispatch
// a built-in the same way it dispatches a pool-served MCP tool:
//
//	embeddedmcp.CallTool(ctx, "Bash", args)
//	pool.Get("websearch").CallTool(ctx, "WebSearch", args)
//
// Both return MCP-shaped result maps. The chat loop's runner adapter
// translates either back into a *tools.Result.
//
// Two surfaces:
//
//   - ListTools     — mirrors the MCP "tools/list" reply shape.
//   - CallTool      — mirrors the MCP "tools/call" reply shape:
//     {content: [{type: "text", text: "..."}], isError?: bool}
//
// Both are direct Go calls into a *tools.Executor — no marshalling
// through stdio, no goroutine fan-out. The handshake (initialize +
// list calls) other MCP servers go through is collapsed into the Go
// types: there is nothing to negotiate when the client and server
// share an address space.
package embeddedmcp

import (
	"context"

	"github.com/yha/core/internal/tools"
)

// Server is an in-process MCP-shaped tool dispatcher backed by a
// *tools.Executor. The zero value is not useful — construct via New.
//
// Concurrency: Server methods are safe for use by multiple goroutines.
// The underlying Executor handles its own per-tool locking.
type Server struct {
	exec *tools.Executor
}

// New returns a Server that delegates every CallTool to exec. The
// catalog reported by ListTools is the executor's static six tools,
// converted to the MCP wire shape.
func New(exec *tools.Executor) *Server {
	return &Server{exec: exec}
}

// ListTools returns the six static built-ins in MCP shape. The result
// matches what an external MCP server would emit for tools/list — name,
// description, inputSchema. No annotations / metadata are attached
// because the bridge-native tool defs don't carry any.
func (s *Server) ListTools() []ToolDef {
	if s == nil || s.exec == nil {
		return nil
	}
	static := tools.StaticTools()
	out := make([]ToolDef, 0, len(static))
	for _, t := range static {
		out = append(out, ToolDef{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}
	return out
}

// CallTool dispatches a tool by name and wraps the executor's *Result
// into the MCP response shape: a content array with one text block plus
// an optional isError flag. Unknown tool names produce IsError=true with
// a clear message — same posture as the executor's "unknown tool"
// branch.
//
// Note: nil args are normalised to an empty map so the executor's
// per-tool handlers see a non-nil input.
func (s *Server) CallTool(ctx context.Context, name string, args map[string]any) (*CallResult, error) {
	if s == nil || s.exec == nil {
		return &CallResult{
			Content: []ContentBlock{{Type: "text", Text: "embeddedmcp: nil executor"}},
			IsError: true,
		}, nil
	}
	if args == nil {
		args = map[string]any{}
	}
	res, err := s.exec.Run(ctx, name, args)
	if err != nil {
		return &CallResult{
			Content: []ContentBlock{{Type: "text", Text: err.Error()}},
			IsError: true,
		}, err
	}
	if res == nil {
		return &CallResult{
			Content: []ContentBlock{{Type: "text", Text: "tool returned nil result"}},
			IsError: true,
		}, nil
	}
	text := res.Content
	if !res.OK && res.Error != "" {
		text = res.Error
	}
	return &CallResult{
		Content: []ContentBlock{{Type: "text", Text: text}},
		IsError: !res.OK,
	}, nil
}

// ToRunnerResult unwraps an MCP CallResult into the simpler *tools.Result
// shape the chat loop's runner expects. Convenience helper for callers
// that bridge between the two surfaces.
func (r *CallResult) ToRunnerResult() *tools.Result {
	if r == nil {
		return &tools.Result{OK: false, Error: "nil CallResult"}
	}
	text := ""
	for _, b := range r.Content {
		if b.Type == "text" {
			text += b.Text
		}
	}
	out := &tools.Result{
		OK:      !r.IsError,
		Content: text,
	}
	if r.IsError {
		out.Error = text
	}
	return out
}

// RunnerAdapter wraps a *Server so it satisfies tools.EmbeddedMCP —
// the interface the composite runner consumes. The adapter exists so
// tools/ can import embeddedmcp without a cycle: callers in main wire
// embeddedmcp.NewRunnerAdapter(srv) into NewCompositeRunner.
type RunnerAdapter struct {
	srv *Server
}

// NewRunnerAdapter returns an adapter wrapping srv.
func NewRunnerAdapter(srv *Server) *RunnerAdapter {
	return &RunnerAdapter{srv: srv}
}

// CallTool delegates to the underlying server and translates the
// MCP-shaped CallResult into the simpler *tools.Result the composite
// runner expects.
func (a *RunnerAdapter) CallTool(ctx context.Context, name string, args map[string]any) (*tools.Result, error) {
	if a == nil || a.srv == nil {
		return &tools.Result{OK: false, Error: "embeddedmcp: nil adapter"}, nil
	}
	raw, err := a.srv.CallTool(ctx, name, args)
	if err != nil {
		if raw != nil {
			return raw.ToRunnerResult(), nil
		}
		return &tools.Result{OK: false, Error: err.Error()}, err
	}
	return raw.ToRunnerResult(), nil
}

// ListTools returns the server's tool defs as the small struct the
// composite runner uses internally.
func (a *RunnerAdapter) ListTools() []tools.EmbeddedMCPTool {
	if a == nil || a.srv == nil {
		return nil
	}
	defs := a.srv.ListTools()
	out := make([]tools.EmbeddedMCPTool, 0, len(defs))
	for _, d := range defs {
		out = append(out, tools.EmbeddedMCPTool{
			Name:        d.Name,
			Description: d.Description,
			InputSchema: d.InputSchema,
		})
	}
	return out
}
