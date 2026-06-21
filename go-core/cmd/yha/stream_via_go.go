package main

// stream_via_go.go implements the --via=go path for `yha prompt`.
//
// It talks to the Go core's native HTTP routes (added Phase 2c+):
//
//	POST /v1/tools/exec        — synchronous tool call
//	POST /v1/stream-direct/    — SSE stream of {type, delta, …} chunks
//
// The chunk shape here is the lowercase-camelCase one emitted by
// internal/stream's route.go (Chunk{Type, Delta, Reasoning, ToolUse,
// ToolResult, Error, DoneReason, Provider}). It is deliberately a
// different shape from the Node bridge's /v1/stream/ payload, which
// is handled by emitChatChunk() in main.go — back-compat lives there.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// goChunk mirrors stream.Chunk on the wire. We accept both camelCase
// (toolUse) and snake_case (tool_use) for the type field so the parser
// stays robust if the bridge ever shifts conventions.
type goChunk struct {
	Type       string         `json:"type"`
	Text       string         `json:"text,omitempty"`
	Delta      string         `json:"delta,omitempty"`
	Reasoning  string         `json:"reasoning,omitempty"`
	ToolUse    map[string]any `json:"toolUse,omitempty"`
	ToolResult map[string]any `json:"toolResult,omitempty"`
	Error      string         `json:"error,omitempty"`
	DoneReason string         `json:"doneReason,omitempty"`
	Provider   string         `json:"provider,omitempty"`
}

// runChatViaGo streams /v1/stream-direct/ chunks straight to stdout.
// Returns the process exit code.
func runChatViaGo(ctx context.Context, pf promptFlags, text string) int {
	body := buildStreamDirectBody(pf, text)
	resp, err := postJSON(ctx, pf, "/v1/stream-direct/", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha prompt:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	return streamGoSSE(resp.Body, pf, false)
}

// runCommandViaGo runs the same /v1/stream-direct/ flow as chat but
// buffers all deltas and prints them once at the end. No streaming
// output, matching the spec for --as=command --via=go.
func runCommandViaGo(ctx context.Context, pf promptFlags, text string) int {
	body := buildStreamDirectBody(pf, text)
	resp, err := postJSON(ctx, pf, "/v1/stream-direct/", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha prompt:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	return streamGoSSE(resp.Body, pf, true)
}

// runToolViaGo POSTs /v1/tools/exec and prints the result content.
// Exit 1 on either {ok:false} or HTTP 4xx/5xx.
func runToolViaGo(ctx context.Context, pf promptFlags) int {
	if pf.name == "" {
		fmt.Fprintln(os.Stderr, "yha prompt --as=tool requires --name=...")
		return 2
	}
	args := map[string]any{}
	if pf.input != "" {
		if err := json.Unmarshal([]byte(pf.input), &args); err != nil {
			fmt.Fprintf(os.Stderr, "yha prompt: --input must be valid JSON: %v\n", err)
			return 2
		}
	}
	body := map[string]any{
		"name": pf.name,
		"args": args,
	}
	// Optional cwd hook — re-uses --session as a convenient string slot
	// only if explicitly empty otherwise. The spec says "cwd? empty-or-from-flag";
	// we don't have a dedicated --cwd flag yet, so leave it empty by default
	// and let the daemon pick its own working directory.
	if pf.session != "" {
		// session is unrelated to cwd; do not leak it. Leave cwd empty.
	}

	resp, err := postJSON(ctx, pf, "/v1/tools/exec", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha prompt:", err)
		return 1
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	httpFail := resp.StatusCode >= 300

	if pf.out == "json" {
		// Pass through raw response bytes for json mode.
		os.Stdout.Write(raw)
		if len(raw) == 0 || raw[len(raw)-1] != '\n' {
			fmt.Println()
		}
		if httpFail {
			return 1
		}
		// Still need to detect ok:false for exit code in json mode.
		var parsed struct {
			Ok bool `json:"ok"`
		}
		if err := json.Unmarshal(raw, &parsed); err == nil && !parsed.Ok {
			return 1
		}
		return 0
	}

	var out struct {
		Ok      bool           `json:"ok"`
		Content string         `json:"content"`
		Error   string         `json:"error"`
		Meta    map[string]any `json:"meta"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		// HTTP error with non-JSON body (e.g. plain text) — print it
		// verbatim so the user sees what the daemon said.
		fmt.Fprintln(os.Stderr, "yha prompt:", strings.TrimSpace(string(raw)))
		return 1
	}
	if out.Content != "" {
		fmt.Println(out.Content)
	}
	if !out.Ok || httpFail {
		if out.Error != "" {
			fmt.Fprintln(os.Stderr, "yha prompt:", out.Error)
		} else if httpFail {
			fmt.Fprintf(os.Stderr, "yha prompt: HTTP %d\n", resp.StatusCode)
		}
		return 1
	}
	return 0
}

// buildStreamDirectBody assembles the request shape for /v1/stream-direct/.
// model defaults are left to the daemon when --model is empty.
func buildStreamDirectBody(pf promptFlags, text string) map[string]any {
	body := map[string]any{
		"input":      text,
		"max_tokens": 4096,
	}
	if pf.model != "" {
		body["model"] = pf.model
	}
	if pf.preset != "" {
		// preset doubles as a system-prompt shortcut. The daemon may
		// interpret this; if not, the daemon should ignore unknowns.
		body["system"] = pf.preset
	}
	return body
}

// streamGoSSE consumes SSE frames where every data: line is a JSON
// object matching goChunk. When buffered=true, deltas are accumulated
// and flushed as a single Println at done time (command mode). Returns
// the process exit code.
func streamGoSSE(r io.Reader, pf promptFlags, buffered bool) int {
	br := bufio.NewReader(r)
	var dataBuf bytes.Buffer
	var collected strings.Builder

	flushFrame := func(payload []byte) (exit int, stop bool) {
		// Pass-through for raw stream mode, but still parse to detect
		// done/error so we can return the right exit code.
		if pf.out == "stream" {
			fmt.Println(string(payload))
		}
		var c goChunk
		if err := json.Unmarshal(payload, &c); err != nil {
			// Non-JSON — print verbatim only if we haven't already.
			if pf.out != "stream" && pf.out == "json" {
				fmt.Println(string(payload))
			}
			return 0, false
		}
		if pf.out == "json" {
			os.Stdout.Write(payload)
			os.Stdout.WriteString("\n")
		}
		return handleGoChunk(&c, pf, buffered, &collected)
	}

	for {
		line, err := br.ReadString('\n')
		if errors.Is(err, io.EOF) {
			// Drain any final un-terminated frame.
			if dataBuf.Len() > 0 {
				if code, stop := flushFrame(dataBuf.Bytes()); stop {
					return code
				}
			}
			break
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "yha prompt: read:", err)
			return 1
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if dataBuf.Len() > 0 {
				if code, stop := flushFrame(dataBuf.Bytes()); stop {
					return code
				}
				dataBuf.Reset()
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimPrefix(line, "data:")
			payload = strings.TrimPrefix(payload, " ")
			if dataBuf.Len() > 0 {
				dataBuf.WriteByte('\n')
			}
			dataBuf.WriteString(payload)
		}
		// "event:" / comments ignored; type is in the JSON body.
	}

	if buffered {
		out := collected.String()
		if out != "" {
			fmt.Println(out)
		}
	} else if !pf.quiet {
		fmt.Fprintln(os.Stderr) // tidy newline
	}
	return 0
}

// handleGoChunk dispatches one parsed chunk. Returns exit code and a
// stop flag — when stop is true, the caller returns immediately.
// Both camelCase ("toolUse") and snake_case ("tool_use") types are
// accepted for forward compatibility.
func handleGoChunk(c *goChunk, pf promptFlags, buffered bool, collected *strings.Builder) (int, bool) {
	if pf.out == "json" || pf.out == "stream" {
		// Already handed to the user verbatim; only react to terminal events.
		switch c.Type {
		case "error":
			if c.Error != "" {
				fmt.Fprintln(os.Stderr, "yha prompt:", c.Error)
			}
			return 1, true
		case "done":
			return 0, true
		}
		return 0, false
	}

	switch c.Type {
	case "delta":
		if buffered {
			collected.WriteString(c.Delta)
		} else {
			fmt.Print(c.Delta)
		}
	case "text":
		// Some providers emit complete text blocks instead of incremental
		// deltas. Treat them the same as a delta in text mode.
		if buffered {
			collected.WriteString(c.Text)
		} else {
			fmt.Print(c.Text)
		}
	case "reasoning":
		if !pf.quiet {
			fmt.Fprintf(os.Stderr, "[thinking] %s", c.Reasoning)
			if !strings.HasSuffix(c.Reasoning, "\n") {
				fmt.Fprintln(os.Stderr)
			}
		}
	case "toolUse", "tool_use":
		if !pf.quiet {
			name := ""
			if c.ToolUse != nil {
				if n, ok := c.ToolUse["name"].(string); ok {
					name = n
				}
			}
			fmt.Fprintf(os.Stderr, "[tool: %s]\n", name)
		}
	case "toolResult", "tool_result":
		if !pf.quiet {
			ok := false
			if c.ToolResult != nil {
				if v, vok := c.ToolResult["ok"].(bool); vok {
					ok = v
				}
			}
			fmt.Fprintf(os.Stderr, "[tool result: %v]\n", ok)
		}
	case "error":
		msg := c.Error
		if msg == "" {
			msg = "stream error"
		}
		fmt.Fprintln(os.Stderr, "yha prompt:", msg)
		return 1, true
	case "done":
		if !buffered {
			fmt.Println()
		}
		return 0, true
	}
	return 0, false
}
