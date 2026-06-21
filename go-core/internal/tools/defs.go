// Tool catalog — Go port of bridge/tools/defs.ts.
//
// StaticTools holds the six bridge-native tools the executor
// implements. BuildCatalog merges them with MCP-derived tools
// (passed in by the caller — this package does not import the mcp
// package directly to keep the dependency one-way: mcp can import
// tools, but not the reverse), de-duplicates names, and applies
// an optional allowlist filter.
package tools

import (
	"regexp"
	"strings"
)

// staticTools is the bridge-native tool catalog, built once at package
// init. Each entry's Source is "bridge"; InputSchema mirrors the
// OpenAI function-calling format (type=object, properties=…, required=[]).
//
// Held package-level so StaticTools() can return a defensive copy of
// the slice header without rebuilding 6 fresh schemas per call. The
// underlying maps are still shared — callers must treat the returned
// Tool values as read-only.
var staticTools = []Tool{
	{
		Name:        "Bash",
		Description: "Execute a shell command and return its combined stdout+stderr (capped at 8000 bytes per stream). Runs in the session working directory; default timeout 60 s.",
		Source:      "bridge",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{
					"type":        "string",
					"description": "Shell command to run.",
				},
				"cwd": map[string]any{
					"type":        "string",
					"description": "Optional working directory; defaults to session cwd.",
				},
				"timeout": map[string]any{
					"type":        "number",
					"description": "Optional timeout in milliseconds; defaults to 60000.",
				},
			},
			"required": []string{"command"},
		},
	},
	{
		Name:        "Read",
		Description: "Read a file from the local filesystem. Returns cat -n style numbered lines with optional offset/limit windowing. Detects binary files and returns a hex preview instead of garbage.",
		Source:      "bridge",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path": map[string]any{
					"type":        "string",
					"description": "Absolute path to the file to read.",
				},
				"offset": map[string]any{
					"type":        "number",
					"description": "1-indexed line to start reading from. Default: 1.",
				},
				"limit": map[string]any{
					"type":        "number",
					"description": "Maximum lines to emit. Default: 2000.",
				},
			},
			"required": []string{"file_path"},
		},
	},
	{
		Name:        "Write",
		Description: "Write or completely overwrite a file. Creates parent directories if needed. Atomic via temp file + rename.",
		Source:      "bridge",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path": map[string]any{
					"type":        "string",
					"description": "Absolute path to write to.",
				},
				"content": map[string]any{
					"type":        "string",
					"description": "Full file content to write.",
				},
			},
			"required": []string{"file_path", "content"},
		},
	},
	{
		Name:        "Glob",
		Description: "Find files by glob pattern (supports `**` recursion). Returns matching paths sorted by mtime descending. Capped at 100 entries.",
		Source:      "bridge",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{
					"type":        "string",
					"description": `Glob pattern to match (e.g. "**/*.go").`,
				},
				"path": map[string]any{
					"type":        "string",
					"description": "Directory to search in. Default: session cwd.",
				},
			},
			"required": []string{"pattern"},
		},
	},
	{
		Name:        "Grep",
		Description: "Search file contents with a regular expression. Output mode controls shape: 'content' (default — matching lines), 'files_with_matches', or 'count'. Optional glob filters which files are scanned.",
		Source:      "bridge",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{
					"type":        "string",
					"description": "Go regexp pattern to search for.",
				},
				"path": map[string]any{
					"type":        "string",
					"description": "File or directory to search. Default: session cwd.",
				},
				"glob": map[string]any{
					"type":        "string",
					"description": `Glob filter for which files to scan (e.g. "*.go").`,
				},
				"output_mode": map[string]any{
					"type":        "string",
					"enum":        []string{"content", "files_with_matches", "count"},
					"description": "Output shape. Default: 'content'.",
				},
				"-n": map[string]any{
					"type":        "boolean",
					"description": "If true, prefix each content line with its line number.",
				},
				"-i": map[string]any{
					"type":        "boolean",
					"description": "If true, match case-insensitively.",
				},
				"head_limit": map[string]any{
					"type":        "number",
					"description": "Maximum entries to return. Default: 250.",
				},
			},
			"required": []string{"pattern"},
		},
	},
	{
		Name:        "WebFetch",
		Description: "Fetch a URL and return its body (capped at 5 MiB). Blocks file://, ftp://, and any URL whose host resolves to a private/loopback IP. Use for documentation, public APIs, or any external HTTP read.",
		Source:      "bridge",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url": map[string]any{
					"type":        "string",
					"description": "Absolute URL (http or https).",
				},
				"prompt": map[string]any{
					"type":        "string",
					"description": "Optional summarisation prompt for downstream LLM use; not interpreted by this tool.",
				},
			},
			"required": []string{"url"},
		},
	},
}

// StaticTools returns a defensive copy of the static tool catalog.
// The slice header is fresh so callers can append/reorder freely; the
// per-entry InputSchema maps are still shared (treat them as read-only).
func StaticTools() []Tool {
	out := make([]Tool, len(staticTools))
	copy(out, staticTools)
	return out
}

// MCPTool is the minimal shape we need from the mcp package to merge
// MCP-relayed tools into the catalog. Defined here as a tiny adapter
// type so this package doesn't import internal/mcp directly.
type MCPTool struct {
	Name        string
	Description string
	InputSchema map[string]any
}

// MCPSource adapts a single MCP tool description into a tools.Tool.
// The returned Source is "mcp:<server>"; namespacing of the Name on
// collisions is the caller's responsibility (BuildCatalog does it).
func MCPSource(serverName string, t MCPTool) Tool {
	desc := t.Description
	if desc == "" {
		desc = "(no description)"
	}
	schema := t.InputSchema
	if schema == nil {
		schema = map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}
	}
	return Tool{
		Name:        t.Name,
		Description: "[MCP:" + serverName + "] " + desc,
		InputSchema: schema,
		Source:      "mcp:" + serverName,
	}
}

// nameSafeRE matches characters that are NOT allowed in OpenAI/Gemini
// tool names. Used to mangle server names into a safe namespace
// prefix when we need to disambiguate colliding MCP tool names.
var nameSafeRE = regexp.MustCompile(`[^a-zA-Z0-9]`)

// mcpServer is a tiny wrapper passed to BuildCatalog so we can carry
// both the server name and its tool list in one slice. Defined here
// rather than as part of the public API; callers construct it
// inline.
type MCPServer struct {
	Name  string
	Tools []MCPTool
}

// BuildCatalog merges the static bridge tool list with MCP-relayed
// tools.
//
//   - Names that collide across multiple MCP servers get prefixed
//     with `<safe_server_name>__`
//   - mcpServers is the list of running MCP servers; pass nil for
//     none. The function does NOT import internal/mcp — convert
//     mcp.Connection.Tools into []MCPTool at the call site.
//   - filter, if non-nil, restricts the result to tools whose Name
//     (or de-prefixed Name) matches an entry. Empty/nil filter means
//     "include everything".
//
// The executor argument is currently unused but kept in the signature
// per the spec — future filters may need to consult per-executor
// state (e.g. allowlist) to decide whether a tool should be exposed.
func BuildCatalog(_ *Executor, mcpServers []MCPServer, filter []string) []Tool {
	out := append([]Tool{}, StaticTools()...)

	// Count names across servers so we know which ones need
	// namespacing.
	nameCount := map[string]int{}
	for _, s := range mcpServers {
		for _, t := range s.Tools {
			nameCount[t.Name]++
		}
	}

	for _, s := range mcpServers {
		safePrefix := nameSafeRE.ReplaceAllString(s.Name, "_") + "__"
		for _, t := range s.Tools {
			tool := MCPSource(s.Name, t)
			if nameCount[t.Name] > 1 {
				tool.Name = safePrefix + t.Name
			}
			out = append(out, tool)
		}
	}

	if len(filter) == 0 {
		return out
	}
	allowed := map[string]struct{}{}
	for _, f := range filter {
		allowed[strings.TrimSpace(f)] = struct{}{}
	}
	filtered := make([]Tool, 0, len(out))
	for _, t := range out {
		if _, ok := allowed[t.Name]; ok {
			filtered = append(filtered, t)
			continue
		}
		// Allow matching the de-namespaced suffix too — same logic the
		// JS catalog uses for the tool_command_overwrite_tools flag.
		if i := strings.Index(t.Name, "__"); i >= 0 {
			if _, ok := allowed[t.Name[i+2:]]; ok {
				filtered = append(filtered, t)
			}
		}
	}
	return filtered
}
