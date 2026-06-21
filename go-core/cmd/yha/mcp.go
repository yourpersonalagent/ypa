package main

// mcp.go — `yha mcp` subcommand.
//
// Talks to the Go core's native MCP control routes (Phase 2c+):
//
//	GET  /v1/mcp/state                   — running + configured servers
//	POST /v1/mcp/start  {name}           — start one
//	POST /v1/mcp/stop   {name}           — stop one
//	GET  /v1/mcp/tools                   — flat catalog grouped by server
//
// Output is a tabwriter table by default; --out=json hands the raw
// daemon payload back unchanged.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
)

// mcpFlags is the shared flag set for every `yha mcp` subcommand.
type mcpFlags struct {
	socket    string
	url       string
	token     string
	tokenFile string
	out       string
	timeout   time.Duration
}

func (mf mcpFlags) toPF() promptFlags {
	return promptFlags{
		socket:    mf.socket,
		url:       mf.url,
		token:     mf.token,
		tokenFile: mf.tokenFile,
		out:       mf.out,
	}
}

// runMCP is the dispatcher invoked from main()'s root switch.
func runMCP(args []string) int {
	if len(args) == 0 {
		return runMCPList(nil)
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "list":
		return runMCPList(rest)
	case "state":
		return runMCPState(rest)
	case "start":
		return runMCPStart(rest)
	case "stop":
		return runMCPStop(rest)
	case "tools":
		return runMCPTools(rest)
	case "help", "--help", "-h":
		printMCPHelp(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "yha mcp: unknown subcommand %q\n\n", sub)
		printMCPHelp(os.Stderr)
		return 2
	}
}

func newMCPFlagSet(name string) (*flag.FlagSet, *mcpFlags) {
	fs := flag.NewFlagSet("mcp "+name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	mf := &mcpFlags{}
	fs.StringVar(&mf.socket, "socket", "", "Unix socket path (default: discovered)")
	fs.StringVar(&mf.url, "url", os.Getenv("YHA_URL"), "remote yha-core URL")
	fs.StringVar(&mf.token, "token", os.Getenv("YHA_TOKEN"), "bearer token for --url")
	fs.StringVar(&mf.tokenFile, "token-file", "", "read bearer token from a file")
	fs.StringVar(&mf.out, "out", "text", "output mode: text | json")
	fs.DurationVar(&mf.timeout, "timeout", 30*time.Second, "request timeout")
	return fs, mf
}

// ── list / state ───────────────────────────────────────────────────────────

func runMCPList(args []string) int {
	fs, mf := newMCPFlagSet("list")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	return doMCPListOrState(*mf, false)
}

func runMCPState(args []string) int {
	fs, mf := newMCPFlagSet("state")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	return doMCPListOrState(*mf, true)
}

// doMCPListOrState: when raw=true (state), --out=json prints the daemon
// payload verbatim. Both default to the same table output.
func doMCPListOrState(mf mcpFlags, raw bool) int {
	ctx, cancel := context.WithTimeout(context.Background(), mf.timeout)
	defer cancel()
	resp, err := getRequest(ctx, mf.toPF(), "/v1/mcp/state")
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha mcp:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha mcp:", err)
		return 1
	}

	if mf.out == "json" {
		if raw {
			os.Stdout.Write(body)
			if len(body) == 0 || body[len(body)-1] != '\n' {
				fmt.Println()
			}
			return 0
		}
		// `list --out=json` emits the parsed servers array for stable
		// scripting, dropping `running` which is implementation-detail.
		var parsed mcpStateResp
		if err := json.Unmarshal(body, &parsed); err != nil {
			fmt.Fprintln(os.Stderr, "yha mcp: parse:", err)
			return 1
		}
		_ = json.NewEncoder(os.Stdout).Encode(parsed.Servers)
		return 0
	}

	var parsed mcpStateResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		fmt.Fprintln(os.Stderr, "yha mcp: parse:", err)
		return 1
	}
	printServerTable(os.Stdout, parsed.Servers)
	return 0
}

type mcpStateResp struct {
	Servers []mcpServerInfo `json:"servers"`
	Running []string        `json:"running"`
}

type mcpServerInfo struct {
	Name       string `json:"name"`
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	ToolsCount int    `json:"tools_count"`
}

func printServerTable(w io.Writer, servers []mcpServerInfo) {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tSTATUS\tTOOLS\tERROR")
	if len(servers) == 0 {
		fmt.Fprintln(tw, "-\t-\t-\t-")
		_ = tw.Flush()
		return
	}
	// Sort for stable output across calls.
	sorted := append([]mcpServerInfo(nil), servers...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	for _, s := range sorted {
		status := "error"
		if s.OK {
			status = "ok"
		}
		errStr := s.Error
		if errStr == "" {
			errStr = "-"
		}
		fmt.Fprintf(tw, "%s\t%s\t%d\t%s\n", s.Name, status, s.ToolsCount, errStr)
	}
	_ = tw.Flush()
}

// ── start / stop ───────────────────────────────────────────────────────────

func runMCPStart(args []string) int { return doStartStop("start", args) }
func runMCPStop(args []string) int  { return doStartStop("stop", args) }

func doStartStop(verb string, args []string) int {
	fs, mf := newMCPFlagSet(verb)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) == 0 {
		fmt.Fprintf(os.Stderr, "yha mcp %s: server name required\n", verb)
		return 2
	}
	name := rest[0]

	ctx, cancel := context.WithTimeout(context.Background(), mf.timeout)
	defer cancel()
	body := map[string]any{"name": name}
	resp, err := postJSON(ctx, mf.toPF(), "/v1/mcp/"+verb, body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha mcp:", err)
		return 1
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	httpFail := resp.StatusCode >= 300

	if mf.out == "json" {
		os.Stdout.Write(raw)
		if len(raw) == 0 || raw[len(raw)-1] != '\n' {
			fmt.Println()
		}
		if httpFail {
			return 1
		}
	}

	var parsed struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(raw, &parsed)

	if !parsed.OK || httpFail {
		msg := parsed.Error
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		fmt.Fprintf(os.Stderr, "yha mcp %s %s: %s\n", verb, name, msg)
		return 1
	}
	if mf.out != "json" {
		fmt.Printf("%s: %s\n", verb+"ed", name)
	}
	return 0
}

// ── tools ──────────────────────────────────────────────────────────────────

func runMCPTools(args []string) int {
	fs, mf := newMCPFlagSet("tools")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	filter := ""
	if len(rest) > 0 {
		filter = rest[0]
	}

	ctx, cancel := context.WithTimeout(context.Background(), mf.timeout)
	defer cancel()
	resp, err := getRequest(ctx, mf.toPF(), "/v1/mcp/tools")
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha mcp:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha mcp:", err)
		return 1
	}

	if mf.out == "json" {
		os.Stdout.Write(body)
		if len(body) == 0 || body[len(body)-1] != '\n' {
			fmt.Println()
		}
		return 0
	}

	var parsed struct {
		Servers map[string][]struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		fmt.Fprintln(os.Stderr, "yha mcp: parse:", err)
		return 1
	}

	// Stable ordering: alphabetical by server, then tool name.
	names := make([]string, 0, len(parsed.Servers))
	for s := range parsed.Servers {
		if filter != "" && s != filter {
			continue
		}
		names = append(names, s)
	}
	sort.Strings(names)
	if filter != "" && len(names) == 0 {
		fmt.Fprintf(os.Stderr, "yha mcp tools: no server named %q\n", filter)
		return 1
	}
	for _, srv := range names {
		tools := parsed.Servers[srv]
		sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
		for _, t := range tools {
			desc := strings.TrimSpace(t.Description)
			if desc == "" {
				fmt.Printf("%s__%s\n", srv, t.Name)
			} else {
				// Collapse multi-line descriptions to first line so the
				// flat list stays one-line-per-tool.
				if i := strings.IndexByte(desc, '\n'); i >= 0 {
					desc = desc[:i]
				}
				fmt.Printf("%s__%s — %s\n", srv, t.Name, desc)
			}
		}
	}
	return 0
}

// ── help ───────────────────────────────────────────────────────────────────

func printMCPHelp(w io.Writer) {
	fmt.Fprintln(w, `yha mcp — manage MCP servers on the daemon

Usage:
  yha mcp [list]              show server status table (alias for `+"`yha mcp list`"+`)
  yha mcp list                show server status table
  yha mcp state               same as list; --out=json prints raw daemon payload
  yha mcp start <name>        start a configured MCP server
  yha mcp stop  <name>        stop a running MCP server
  yha mcp tools [<server>]    flat list of <server>__<tool> — <description>

Flags (shared):
  --socket=PATH     Unix socket path (default: discovered)
  --url=URL         remote yha-core URL
  --token=TOKEN     bearer token for --url
  --token-file=PATH read bearer token from a file
  --out=text|json   output mode (default: text)
  --timeout=DUR     request timeout (default: 30s)

Examples:
  yha mcp
  yha mcp start knowledge-memory
  yha mcp tools websearch
  yha mcp state --out=json | jq .`)
}
