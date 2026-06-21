package main

// tui.go — `yha tui` subcommand. Thin flag-parse + handoff to the
// cmd/yha/tui sub-package. Keeps TUI internals isolated so the rest
// of the CLI (which is non-interactive) doesn't pull in bubbletea.

import (
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/yha/core/cmd/yha/tui"
)

func runTUI(args []string) int {
	fs := flag.NewFlagSet("tui", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	url := fs.String("url", os.Getenv("YHA_URL"), "remote yha-core URL (overrides socket)")
	token := fs.String("token", os.Getenv("YHA_TOKEN"), "bearer token for --url")
	tokenFile := fs.String("token-file", "", "read bearer token from a file")
	socket := fs.String("socket", "", "Unix socket path (default: discovered)")
	model := fs.String("model", os.Getenv("YHA_MODEL"), "default model id (e.g. claude-opus-4-7)")
	via := fs.String("via", "direct", "stream route: direct (Go-native /v1/stream-direct/, default) | harness (Node bridge /v1/stream/ — deleted in Phase 7, only works if you restore the route locally)")
	timeout := fs.Duration("timeout", 10*time.Minute, "per-request timeout")

	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `yha tui — interactive terminal UI

Usage:
  yha tui [flags]

Flags:
  --url=URL           remote yha-core URL (default: $YHA_URL)
  --token=TOKEN       bearer token (default: $YHA_TOKEN)
  --token-file=PATH   read bearer token from file
  --socket=PATH       Unix socket path (default: discovered)
  --model=ID          default model id (default: $YHA_MODEL)
  --via=direct|harness route the chat POST. direct (default) hits
                      /v1/stream-direct/ on the Go core (the only live
                      chat endpoint after Phase 7). harness was Node's
                      /v1/stream/ for Claude Code subscription billing
                      but the route was deleted; opt in only if you've
                      restored it locally.
  --timeout=DUR       per-request timeout (default: 10m)

Keys:
  Tab / Shift+Tab     switch tabs (Chat, Sessions, MCP)
  Ctrl+N              start a fresh chat (clear active session)
  Esc                 cancel a stream (or blur the composer)
  i                   refocus the composer after Esc
  m                   open the model picker (chat tab, input blurred)
  e                   cycle reasoning effort low → medium → high → max
  Ctrl+C / q          quit (q only when chat input is unfocused)`)
	}

	if err := fs.Parse(args); err != nil {
		return 2
	}

	// Local-dev convenience: when neither --url/--token nor their env
	// equivalents are set, look up bridge/.env on disk so `yha tui` from
	// the project root mirrors the web app's "just works" feel.
	applyLocalDevDefaults(url, token)

	// One-shot startup banner before bubbletea takes the alt-screen.
	// Surfaces the four things people debug after a "why didn't this
	// work" moment: which URL we're hitting, whether a token was found
	// and where it came from, which socket fallback we'd use, and which
	// stream route the chat tab will post to. Goes to stderr so it
	// survives the alt-screen swap (stderr stays on the parent tty).
	printStartupBanner(*url, *token, *tokenFile, *socket, *via)

	return tui.Run(tui.Options{
		URL:       *url,
		Token:     *token,
		TokenFile: *tokenFile,
		Socket:    *socket,
		Model:     *model,
		Via:       *via,
		Timeout:   *timeout,
	})
}

// printStartupBanner emits three lines to stderr summarising the
// connection the TUI is about to use. Quiet when YHA_TUI_QUIET=1 is set
// (useful for scripts that just want the alt-screen frame).
func printStartupBanner(url, token, tokenFile, socket, via string) {
	if os.Getenv("YHA_TUI_QUIET") == "1" {
		return
	}
	target := url
	if target == "" {
		if socket != "" {
			target = "unix:" + socket
		} else {
			target = "unix:(auto-discovered socket)"
		}
	}
	tokenLabel := "none"
	switch {
	case token != "" && tokenFile != "":
		tokenLabel = "set (--token-file)"
	case token != "" && os.Getenv("YHA_TOKEN") != "":
		tokenLabel = "set ($YHA_TOKEN)"
	case token != "":
		tokenLabel = "set (--token or bridge/.env auto-discovered)"
	}
	streamPath := "/v1/stream-direct/"
	if via == "harness" {
		streamPath = "/v1/stream/ (legacy; route deleted in Phase 7)"
	}
	fmt.Fprintf(os.Stderr, "→ YHA TUI connecting to %s\n", target)
	fmt.Fprintf(os.Stderr, "→ bearer token: %s\n", tokenLabel)
	fmt.Fprintf(os.Stderr, "→ chat route:   POST %s\n", streamPath)
}
