// Public types for the tool dispatcher. Ported from
// bridge/tools/exec.ts + bridge/tools/defs.ts.
//
// Tool is the catalog shape (the tool def — name, description,
// JSONSchema-flavoured input schema, source provenance). Result is
// what Run hands back: a primary text Content plus optional Meta
// fields the caller may surface (exit codes, byte counts, timing).
//
// Executor is the interface that the bridge tool catalog satisfies;
// other modules can swap in alternate implementations for tests.
package tools

import "context"

// Tool is one entry in the catalog. The Source field lets callers
// distinguish bridge-native tools ("bridge") from MCP-relayed ones
// ("mcp:<server>") for routing and telemetry.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Source      string         `json:"source"`
}

// Result is the dispatcher's return shape. OK=true means the call
// completed successfully — Error stays empty. OK=false means the
// tool itself failed (path rejected, command timed out, …); Error
// holds the message. Meta carries tool-specific fields.
type Result struct {
	OK      bool           `json:"ok"`
	Content string         `json:"content"`
	Error   string         `json:"error,omitempty"`
	Meta    map[string]any `json:"meta,omitempty"`
}

// Executor dispatches a tool call by name. Implementations own the
// catalog they advertise via Tools().
type ExecutorAPI interface {
	Run(ctx context.Context, name string, args map[string]any) (*Result, error)
	Tools() []Tool
}
