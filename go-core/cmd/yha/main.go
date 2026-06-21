// yha is the CLI client for the YHA bridge.
//
// Talks to the local yha-core daemon via Unix socket (preferred) or to
// a remote yha-core via HTTPS+bearer. Each invocation is a single OS
// process; combine with `&`, `xargs -P`, or GNU parallel for concurrency.
//
// Subcommands:
//   yha prompt [text...]   send a prompt (--as=chat|command|skill|tool|agent)
//   yha status             show daemon health
//   yha version            print version
//   yha help [<cmd>]       per-command help
//
// Phase 3 fills in skill/tool/agent dispatch through the meta-bridge MCP.
// Phase 1 ships chat/command via /v1/stream/ and /v1/command/ on the bridge.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const version = "0.1.0-phase0"

func main() {
	if len(os.Args) < 2 {
		printRootHelp(os.Stdout)
		os.Exit(0)
	}
	cmd := os.Args[1]
	args := os.Args[2:]
	switch cmd {
	case "prompt":
		os.Exit(runPrompt(args))
	case "status":
		os.Exit(runStatus(args))
	case "serve":
		os.Exit(runServe(args))
	case "mcp":
		os.Exit(runMCP(args))
	case "session":
		os.Exit(runSession(args))
	case "cost":
		os.Exit(runCost(args))
	case "logs":
		os.Exit(runLogs(args))
	case "rewind":
		os.Exit(runRewind(args))
	case "tui":
		os.Exit(runTUI(args))
	case "cmd":
		os.Exit(runCmd(args))
	case "setup":
		os.Exit(runSetup(args))
	case "repair":
		os.Exit(runRepair(args))
	case "version", "--version", "-v":
		fmt.Println("yha", version)
		os.Exit(0)
	case "help", "--help", "-h":
		runHelp(args)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "yha: unknown command %q\n\n", cmd)
		printRootHelp(os.Stderr)
		os.Exit(2)
	}
}

func printRootHelp(w io.Writer) {
	fmt.Fprintf(w, `yha %s — CLI client for the YHA bridge

Usage:
  yha <command> [flags]

Commands:
  prompt   send a prompt to a chat / command / skill / tool / agent
  status   show daemon health
  serve    start/list/stop/share per-CWD preview servers
  mcp      list / start / stop MCP servers and tools
  session  list / inspect / kill bridge sessions
  cost     show cost totals (per day, per week, per model)
  logs     show bridge logs (or surface a clear error if not exposed)
  rewind   list / show / apply edit records from the rewind safety net
  tui      open the interactive terminal UI
  cmd      run a YHA-TUI-Daemon command non-interactively
  setup    first-time install + wizard (stub — see 'yha cmd --list')
  repair   diagnose + repair install state (stub — see 'yha cmd --list')
  version  print client version
  help     show help for a command

Run 'yha help <command>' for per-command flags.

Connection:
  By default the CLI uses the local Unix socket. Override with:
    --socket=/path           use a different Unix socket
    --url=https://host:8443  use HTTPS (set $YHA_TOKEN for auth)
  $YHA_CORE_SOCKET, $YHA_URL, $YHA_TOKEN are read as defaults.
`, version)
}

// ── prompt ─────────────────────────────────────────────────────────────────

type promptFlags struct {
	as        string
	name      string
	model     string
	preset    string
	harness   string
	session   string
	input     string
	out       string
	via       string
	socket    string
	url       string
	token     string
	tokenFile string
	timeout   time.Duration
	quiet     bool
}

func runPrompt(args []string) int {
	fs := flag.NewFlagSet("prompt", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	pf := promptFlags{}
	fs.StringVar(&pf.as, "as", envOr("YHA_AS", "chat"), "dispatch type: chat | command | skill | tool | agent")
	fs.StringVar(&pf.name, "name", "", "skill / tool / agent name (required when --as is not chat/command)")
	fs.StringVar(&pf.model, "model", os.Getenv("YHA_MODEL"), "model id (e.g. claude-opus-4-7); empty = bridge default")
	fs.StringVar(&pf.preset, "preset", "", "preset name (system prompt key)")
	fs.StringVar(&pf.harness, "harness", "", "harness id (claude-binary | claude-sdk | codex | direct-api)")
	fs.StringVar(&pf.session, "session", "", "session id; empty = ephemeral")
	fs.StringVar(&pf.input, "input", "", `JSON input for --as=tool, e.g. '{"command":"ls"}'`)
	fs.StringVar(&pf.out, "out", "text", "output mode: text | json | stream")
	fs.StringVar(&pf.via, "via", envOr("YHA_VIA", "mcp"), "transport: mcp (Node bridge) | go (native /v1/* routes)")
	fs.StringVar(&pf.socket, "socket", "", "Unix socket path (default: discovered)")
	fs.StringVar(&pf.url, "url", os.Getenv("YHA_URL"), "remote yha-core URL (overrides socket)")
	fs.StringVar(&pf.token, "token", os.Getenv("YHA_TOKEN"), "bearer token for --url")
	fs.StringVar(&pf.tokenFile, "token-file", "", "read bearer token from a file")
	fs.DurationVar(&pf.timeout, "timeout", 10*time.Minute, "request timeout")
	fs.BoolVar(&pf.quiet, "quiet", false, "suppress non-content output")

	if err := fs.Parse(args); err != nil {
		return 2
	}

	// Positional args become the prompt text. Stays unset when reading from stdin.
	tail := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if tail == "" {
		// Allow piping prompt text via stdin.
		if isPipedStdin() {
			b, err := io.ReadAll(os.Stdin)
			if err != nil {
				fmt.Fprintln(os.Stderr, "yha prompt: stdin:", err)
				return 1
			}
			tail = strings.TrimSpace(string(b))
		}
	}
	if tail == "" && pf.as != "tool" {
		fmt.Fprintln(os.Stderr, "yha prompt: text is required (positional or stdin)")
		fs.Usage()
		return 2
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	ctx, cancelTimeout := context.WithTimeout(ctx, pf.timeout)
	defer cancelTimeout()

	// Validate --via early. skill/agent ignore the flag — they always
	// flow through the meta-bridge MCP for now.
	switch pf.via {
	case "", "mcp", "go":
		// ok
	default:
		fmt.Fprintf(os.Stderr, "yha prompt: unknown --via=%q (valid: mcp, go)\n", pf.via)
		return 2
	}

	switch pf.as {
	case "chat":
		if pf.via == "go" {
			return runChatViaGo(ctx, pf, tail)
		}
		return doChat(ctx, pf, tail)
	case "command":
		if pf.via == "go" {
			return runCommandViaGo(ctx, pf, tail)
		}
		return doCommand(ctx, pf, tail)
	case "skill":
		return doSkillToolAgent(ctx, pf, "skill", tail)
	case "tool":
		if pf.via == "go" {
			return runToolViaGo(ctx, pf)
		}
		return doSkillToolAgent(ctx, pf, "tool", tail)
	case "agent":
		return doSkillToolAgent(ctx, pf, "agent", tail)
	default:
		fmt.Fprintf(os.Stderr, "yha prompt: unknown --as=%q (valid: chat, command, skill, tool, agent)\n", pf.as)
		return 2
	}
}

// ── chat (SSE streaming) ───────────────────────────────────────────────────

func doChat(ctx context.Context, pf promptFlags, text string) int {
	body := map[string]any{"Input": text}
	if pf.model != "" {
		body["Model"] = pf.model
	}
	if pf.preset != "" {
		body["Preset"] = pf.preset
	}
	if pf.session != "" {
		body["SessionId"] = pf.session
	}
	if pf.harness != "" {
		body["HarnessInstance"] = pf.harness
	}
	resp, err := postJSON(ctx, pf, "/v1/stream/", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha prompt:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	return streamSSE(resp.Body, pf)
}

func streamSSE(r io.Reader, pf promptFlags) int {
	br := bufio.NewReader(r)
	// SSE frames are "event:" / "data:" lines separated by blank lines.
	var dataBuf bytes.Buffer
	for {
		line, err := br.ReadString('\n')
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "yha prompt: read:", err)
			return 1
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			// frame complete
			if dataBuf.Len() > 0 {
				if pf.out == "stream" {
					fmt.Println(dataBuf.String())
				} else {
					emitChatChunk(dataBuf.Bytes(), pf)
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
		// "event:" lines are ignored for now; the bridge embeds the kind
		// inside the JSON payload.
	}
	if !pf.quiet {
		fmt.Fprintln(os.Stderr) // trailing newline for tidy shells
	}
	return 0
}

// emitChatChunk handles the JSON shape used by /v1/stream/. The bridge
// emits objects like {text, delta} | {reasoning} | {toolUse} | {toolResult}
// | {done}. For --out=text we print only the text deltas.
func emitChatChunk(payload []byte, pf promptFlags) {
	var chunk map[string]any
	if err := json.Unmarshal(payload, &chunk); err != nil {
		// Not JSON — pass through verbatim in text mode.
		if pf.out == "text" {
			os.Stdout.Write(payload)
			os.Stdout.WriteString("\n")
		}
		return
	}
	if pf.out == "json" {
		os.Stdout.Write(payload)
		os.Stdout.WriteString("\n")
		return
	}
	if delta, ok := chunk["delta"].(string); ok && delta != "" {
		fmt.Print(delta)
		return
	}
	if t, ok := chunk["text"].(string); ok && t != "" {
		fmt.Print(t)
		return
	}
	if !pf.quiet {
		if u, ok := chunk["toolUse"].(map[string]any); ok {
			fmt.Fprintf(os.Stderr, "\n[tool: %v]\n", u["name"])
		}
	}
}

// ── command (non-streaming) ────────────────────────────────────────────────

func doCommand(ctx context.Context, pf promptFlags, text string) int {
	body := map[string]any{"Input": text}
	if pf.model != "" {
		body["Model"] = pf.model
	}
	if pf.preset != "" {
		body["Preset"] = pf.preset
	}
	if pf.session != "" {
		body["SessionId"] = pf.session
	}
	resp, err := postJSON(ctx, pf, "/v1/command/", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha prompt:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	if pf.out == "json" {
		_, _ = io.Copy(os.Stdout, resp.Body)
		fmt.Println()
		return 0
	}
	var out struct {
		Success  bool   `json:"success"`
		Response string `json:"response"`
		Error    string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		fmt.Fprintln(os.Stderr, "yha prompt: parse response:", err)
		return 1
	}
	if !out.Success {
		fmt.Fprintln(os.Stderr, "yha prompt:", out.Error)
		return 1
	}
	fmt.Println(out.Response)
	return 0
}

// doSkillToolAgent (legacy meta-bridge MCP path) lives in prompt_via_mcp.go.
// runStatus lives in status.go. runHelp lives in help.go.
// HTTP plumbing (postJSON, getRequest, clientFor, urlFor, socketPath,
// tokenFor, dumpErr, envOr, isPipedStdin) lives in http.go.
