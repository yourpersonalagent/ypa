package main

// prompt_via_mcp.go — the legacy meta-bridge MCP path for
// --as=skill | --as=tool | --as=agent. Speaks JSON-RPC over
// /proxy/mcp-bridge/rpc and unwraps the MCP { content: [{ text }] }
// shape for text mode. This is the default for skill/agent/tool when
// --via=mcp (the back-compat default) and is always used for skill /
// agent regardless of --via.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
)

// Tool names are namespaced "<server>__<tool>" by the aggregator
// bridge (bridge/modules/mcp-client/lib/bridge.ts). meta-bridge's
// own tools land as "meta-bridge__meta_invoke_skill" etc.
const metaBridgeServer = "meta-bridge"

func doSkillToolAgent(ctx context.Context, pf promptFlags, kind, text string) int {
	if pf.name == "" {
		fmt.Fprintf(os.Stderr, "yha prompt --as=%s requires --name=...\n", kind)
		return 2
	}

	var toolName string
	var args map[string]any
	switch kind {
	case "skill", "agent":
		// Same shape: meta_invoke_skill { name }. agent vs skill is a
		// metadata distinction in the skill catalog, not in the call.
		toolName = metaBridgeServer + "__meta_invoke_skill"
		args = map[string]any{"name": pf.name}
	case "tool":
		// Dispatch the named tool directly through the aggregator.
		// --name accepts either a namespaced "<server>__<tool>" id (the
		// canonical form returned by tools/list) or a bare name when
		// it's globally unique (e.g. "Bash" from the bridge itself).
		toolName = pf.name
		args = map[string]any{}
		if pf.input != "" {
			if err := json.Unmarshal([]byte(pf.input), &args); err != nil {
				fmt.Fprintf(os.Stderr, "yha prompt: --input must be valid JSON: %v\n", err)
				return 2
			}
		}
	default:
		fmt.Fprintf(os.Stderr, "yha prompt: internal error — unknown kind %q\n", kind)
		return 2
	}

	// Positional `text` is unused for these kinds — skill/agent fetch
	// the SKILL.md body, tool gets its inputs from --input.
	_ = text

	body := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": toolName, "arguments": args},
	}

	resp, err := postJSON(ctx, pf, "/proxy/mcp-bridge/rpc", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha prompt:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}

	var rpcResp struct {
		Result any            `json:"result"`
		Error  map[string]any `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rpcResp); err != nil {
		fmt.Fprintln(os.Stderr, "yha prompt: parse response:", err)
		return 1
	}
	if rpcResp.Error != nil {
		fmt.Fprintf(os.Stderr, "yha prompt: meta-bridge error: %v\n", rpcResp.Error)
		return 1
	}

	if pf.out == "json" {
		_ = json.NewEncoder(os.Stdout).Encode(rpcResp.Result)
		return 0
	}

	// MCP tool results have shape { content: [{ type: "text", text }] }.
	// Print every text block; if the shape is unexpected, fall back to JSON.
	if m, ok := rpcResp.Result.(map[string]any); ok {
		if content, ok := m["content"].([]any); ok {
			for _, c := range content {
				if cm, ok := c.(map[string]any); ok {
					if t, ok := cm["text"].(string); ok {
						fmt.Println(t)
						continue
					}
				}
			}
			return 0
		}
	}
	_ = json.NewEncoder(os.Stdout).Encode(rpcResp.Result)
	return 0
}
