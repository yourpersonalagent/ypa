package main

// help.go — `yha help` and per-command help bodies.

import (
	"fmt"
	"os"
)

func runHelp(args []string) {
	if len(args) == 0 {
		printRootHelp(os.Stdout)
		return
	}
	switch args[0] {
	case "prompt":
		fmt.Println(`yha prompt — send a prompt to the bridge

Usage:
  yha prompt [text...]
  echo "text" | yha prompt

Flags:
  --as=chat|command|skill|tool|agent  dispatch type (default: chat)
  --name=NAME                          skill / tool / agent name
  --model=ID                           model id (e.g. claude-opus-4-7)
  --preset=NAME                        preset name
  --harness=ID                         harness id (claude-binary | claude-sdk | codex | direct-api)
  --session=ID                         session id; empty = ephemeral
  --input=JSON                         JSON input for --as=tool
  --out=text|json|stream               output mode (default: text)
  --via=mcp|go                         transport: mcp = Node bridge proxy (default,
                                         back-compat); go = native Go routes
                                         (/v1/tools/exec, /v1/stream-direct/).
                                         Applies to --as=chat|command|tool only.
  --socket=PATH                        Unix socket path
  --url=URL                            remote yha-core URL
  --token=TOKEN                        bearer token for --url
  --token-file=PATH                    read bearer token from a file
  --timeout=DUR                        request timeout (default: 10m)
  --quiet                              suppress tool-use chatter

Examples:
  yha prompt "summarise this PR"
  yha prompt --model=claude-opus-4-7 "draft a release note"
  echo "text" | yha prompt --as=command
  yha prompt --as=skill --name=browse "find the latest pricing"
  yha prompt --as=tool  --name=Bash  --input='{"command":"ls"}'
  yha prompt --as=chat  --via=go --model=claude-opus-4-7 "hello"

Each invocation is a single OS process — combine with & or xargs -P
for true bash parallelism.`)
	case "status":
		fmt.Println(`yha status — show daemon health

Usage:
  yha status

Flags:
  --socket=PATH    Unix socket path (default: discovered)
  --url=URL        remote yha-core URL
  --out=text|json  output mode`)
	case "serve":
		printServeHelp(os.Stdout)
	case "mcp":
		printMCPHelp(os.Stdout)
	case "session":
		printSessionHelp(os.Stdout)
	case "cost":
		fmt.Println(`yha cost — show cost totals from the bridge

Usage:
  yha cost                  per-day table, most recent first (default)
  yha cost --today          today's costs grouped by model
  yha cost --week           sum of the last 7 days, grouped by model
  yha cost --model=ID       filter to one model id (e.g. claude-opus-4-7)

Flags:
  --socket=PATH     Unix socket path (default: discovered)
  --url=URL         remote yha-core URL
  --token=TOKEN     bearer token for --url
  --token-file=PATH read bearer token from a file
  --out=text|json   output mode (default: text)
  --timeout=DUR     request timeout (default: 30s)

Source:
  Hits GET /v1/costs on the daemon (registered by
  bridge/modules/observability-plus/costs.ts). The CLI never reads
  bridge/costs.json directly so it works over the network too.

Examples:
  yha cost
  yha cost --today
  yha cost --week --model=claude-opus-4-7
  yha cost --out=json | jq '.allTime.byModel'`)
	case "rewind":
		printRewindHelp(os.Stdout)
	case "tui":
		fmt.Println(`yha tui — interactive terminal UI

Usage:
  yha tui [flags]

Flags:
  --url=URL           remote yha-core URL
  --token=TOKEN       bearer token for --url
  --token-file=PATH   read bearer token from file
  --socket=PATH       Unix socket path
  --model=ID          default model id (e.g. claude-opus-4-7)
  --via=harness|direct  chat route — harness goes through the Node bridge's
                        /v1/stream/ (claude-binary / sdk / codex subprocesses,
                        uses your Claude Code subscription); direct goes
                        through Go's /v1/stream-direct/ (Anthropic/OpenAI/
                        Gemini API, burns provider credit). Default: harness.
  --timeout=DUR       per-request timeout (default: 10m)

Tabs:
  Chat       — live SSE streaming, harness or direct route per --via
  Sessions   — lazy-loaded session picker; Enter switches the chat to it
  MCP        — placeholder, inert in v1

Keys (chat tab, when input is unfocused — press Esc to unfocus):
  m            open the model picker (fuzzy search + capability badges)
  e            cycle reasoning effort: low → medium → high → max → low
  i            refocus the input (vi-style)
  Tab / S-Tab  switch tabs
  Ctrl+N       fresh chat (clear active session)
  Esc          cancel an in-flight stream / unfocus input
  Ctrl+C / q   quit (q only when input is unfocused)

Picker (model overlay):
  type to filter   ·   ↑/↓ or Ctrl+P/N navigate   ·   Enter pick   ·   Esc cancel`)
	case "logs":
		fmt.Println(`yha logs — show bridge logs (or fail loud)

Usage:
  yha logs                  fetch the last --lines=N (when a tail endpoint exists)
  yha logs --follow         stream logs as they're written
  yha logs --filter=ERROR   client-side substring filter
  yha logs --status         show whether API logging is enabled

Flags:
  --lines=N         how many lines to pull (default: 100)
  --follow          keep streaming new lines
  --filter=PATTERN  substring filter applied client-side
  --status          GET /v1/logging — show feature-toggle state
  --socket=PATH     Unix socket path
  --url=URL         remote yha-core URL
  --token=TOKEN     bearer token for --url
  --token-file=PATH read bearer token from a file
  --out=text|json   output mode (default: text)
  --timeout=DUR     request timeout (default: 30s)

Caveat:
  As of this release the bridge only exposes /v1/logging (a feature
  toggle). If no tail endpoint is reachable, this command exits with:
    yha logs: bridge does not expose a logging endpoint
             — try pm2 logs YHA-Bridge instead

  When the bridge ships /v1/logging/tail (or similar) the CLI picks it
  up automatically — no release needed.`)
	case "cmd":
		printCmdHelp(os.Stdout)
		fmt.Println()
		printCmdList(os.Stdout)
	case "setup", "repair":
		fmt.Printf(`yha %s — stub for the future install/repair flow

Usage:
  yha %s [flags...]

Today this is a no-op stub: it prints a not-yet-implemented message
through the daemon's job runner so the UI surface is wired up. The
real logic lands with the public-binary install work — see
docs/YHA-TUI-Replacement-Plan.md §5.

Flags inherited from 'yha cmd':
  --origin=LABEL    annotate as [external: <LABEL>] in viewer
  --no-wait         spawn and exit (prints job_id)
  --socket=PATH     daemon socket path (default: discovered)
`, args[0], args[0])
	default:
		fmt.Fprintf(os.Stderr, "yha help: no help for %q\n", args[0])
		os.Exit(2)
	}
}
