// Adapter that wraps *Pool (and the *Connection it returns) so they
// satisfy internal/tools' MCPPool / MCPConnection surfaces. The
// composite runner in internal/tools needs these but can't import
// internal/mcp directly without closing a cycle, so the adapter lives
// here.
package mcp

import (
	"context"

	"github.com/yha/core/internal/tools"
)

// PoolAdapter wraps a *Pool so it satisfies tools.MCPPool.
type PoolAdapter struct {
	pool *Pool
}

// NewPoolAdapter constructs an adapter around the supplied pool.
func NewPoolAdapter(pool *Pool) *PoolAdapter {
	return &PoolAdapter{pool: pool}
}

// List returns the pool's connections wrapped as tools.MCPConnection.
func (a *PoolAdapter) List() []tools.MCPConnection {
	if a == nil || a.pool == nil {
		return nil
	}
	conns := a.pool.List()
	out := make([]tools.MCPConnection, 0, len(conns))
	for _, c := range conns {
		out = append(out, &connectionAdapter{conn: c})
	}
	return out
}

// connectionAdapter wraps *Connection so it satisfies
// tools.MCPConnection. Field-based access is fine — Tools is guarded
// by the Connection's own RWMutex internally via snapshotTools.
type connectionAdapter struct {
	conn *Connection
}

// ServerName satisfies tools.MCPConnection.
func (a *connectionAdapter) ServerName() string {
	if a == nil || a.conn == nil {
		return ""
	}
	return a.conn.Name
}

// Tools satisfies tools.MCPConnection. We translate the mcp.Tool wire
// type into tools.MCPTool because the latter lives in the consumer's
// import-free shape (no mcp dependency).
func (a *connectionAdapter) Tools() []tools.MCPTool {
	if a == nil || a.conn == nil {
		return nil
	}
	mcpTools := a.conn.snapshotTools()
	out := make([]tools.MCPTool, 0, len(mcpTools))
	for _, t := range mcpTools {
		out = append(out, tools.MCPTool{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}
	return out
}

// CallTool delegates to the underlying Connection.
func (a *connectionAdapter) CallTool(ctx context.Context, toolName string, args map[string]any) (map[string]any, error) {
	if a == nil || a.conn == nil {
		return nil, nil
	}
	return a.conn.CallTool(ctx, toolName, args)
}
