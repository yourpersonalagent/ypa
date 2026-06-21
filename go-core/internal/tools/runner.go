// Runner is the abstract tool dispatch surface used by callers that need
// to drive a tool catalog without coupling to the concrete *Executor.
//
// The interface intentionally narrows ExecutorAPI down to the two things
// the chat-streaming loop needs: a Run(ctx, name, args) call and a
// Catalog() snapshot the model should see. CompositeRunner satisfies
// this interface by fanning out across the embedded MCP server, the
// running MCP pool, and the Node-callback runner.
//
// *Executor also satisfies Runner natively — Catalog() returns the
// memoised static-tool slice from defs.go.
package tools

import "context"

// Runner is the chat loop's view of the tool dispatch layer. Implementations
// must be safe to call concurrently from multiple goroutines: Run() may
// be invoked while Catalog() is mid-build on a refresh path.
type Runner interface {
	// Run dispatches a tool call by name. Implementations decide which
	// backend (builtin, MCP, Node) handles the call. Unknown names
	// produce OK=false with a clear message rather than an error so the
	// model can recover; genuine system failures (context cancellation,
	// programming errors) propagate as the second return value.
	Run(ctx context.Context, name string, args map[string]any) (*Result, error)

	// Catalog returns the tools this runner can dispatch. Stability is
	// not guaranteed across calls — composite implementations may
	// refresh from an upstream catalog endpoint and the result may grow
	// or shrink between invocations.
	Catalog() []Tool
}

// Catalog returns the executor's static tool list. *Executor implements
// the Runner interface this way; the underlying staticTools slice is
// shared but the slice header is fresh, matching StaticTools()'s
// defensive-copy contract.
func (e *Executor) Catalog() []Tool {
	return e.Tools()
}
