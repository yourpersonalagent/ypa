package embeddedmcp

// ToolDef is one entry in a tools/list reply. JSON tags match the MCP
// wire shape so a future caller can marshal these straight onto the
// pool's existing surface.
type ToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// CallResult is the MCP tools/call response. Content is a typed array
// of blocks (only "text" today, but the shape leaves room for other
// block types when the bridge grows them). IsError flips the success
// posture without changing the wire shape — the model can still read
// the text for context.
type CallResult struct {
	Content []ContentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
}

// ContentBlock is one entry in CallResult.Content. Type is always "text"
// for the bridge-native tools today; the MCP spec permits "image" /
// "resource" blocks but the six built-ins emit text only.
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}
