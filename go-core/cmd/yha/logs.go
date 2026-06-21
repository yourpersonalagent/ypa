package main

// logs.go — `yha logs` subcommand.
//
// The bridge currently does NOT expose a log-tail endpoint:
//
//   - GET  /v1/logging        — returns {enabled: bool}, the API-logging
//                                feature toggle. Not a log stream.
//   - POST /v1/logging        — flips that toggle. Also not a log stream.
//
// (Search bridge/server.ts and bridge/routes/system.ts: the only
// `/v1/log*` routes are the toggle pair above.)
//
// Until the bridge ships a real tail/SSE endpoint, this command surfaces
// a clear error pointing the user at pm2. We deliberately do NOT shell
// out to pm2 ourselves — the CLI is meant to work over the network too,
// and reading pm2 log files requires colocated filesystem access we
// can't assume.
//
// When a tail endpoint lands (e.g. /v1/logging/tail or
// /v1/logging/stream), wire it in here: the flag plumbing below already
// covers --follow / --filter / --lines and just needs a real fetch loop.

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func runLogs(args []string) int {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	socket := fs.String("socket", "", "Unix socket path (default: discovered)")
	url := fs.String("url", os.Getenv("YHA_URL"), "remote yha-core URL")
	token := fs.String("token", os.Getenv("YHA_TOKEN"), "bearer token for --url")
	tokenFile := fs.String("token-file", "", "read bearer token from a file")
	outFlag := fs.String("out", "text", "output mode: text | json")
	timeout := fs.Duration("timeout", 30*time.Second, "request timeout")

	follow := fs.Bool("follow", false, "stream logs as they're written (requires bridge tail endpoint)")
	filter := fs.String("filter", "", "client-side substring filter applied to each line")
	lines := fs.Int("lines", 100, "fetch the last N lines (when a tail endpoint exists)")
	status := fs.Bool("status", false, "show whether API logging is enabled (GET /v1/logging)")

	if err := fs.Parse(args); err != nil {
		return 2
	}

	pf := promptFlags{
		socket:    *socket,
		url:       *url,
		token:     *token,
		tokenFile: *tokenFile,
		out:       *outFlag,
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	// `--status` queries the API-logging feature toggle so users at
	// least have a way to ask "is the bridge currently recording API
	// traffic?" through this command. Same plumbing pattern as the
	// other `yha` subcommands.
	if *status {
		return runLogsStatus(ctx, pf)
	}

	// Probe a few likely tail endpoints. None are wired today, but
	// keeping the probe means: the day a tail endpoint lands the CLI
	// just starts working without a release. We probe with HEAD-then-
	// GET and tolerate 404/501 silently.
	if endpoint, ok := probeTailEndpoint(ctx, pf); ok {
		return doTail(ctx, pf, endpoint, *follow, *filter, *lines)
	}

	// No tail endpoint — surface the contract per the spec.
	fmt.Fprintln(os.Stderr,
		"yha logs: bridge does not expose a logging endpoint — try pm2 logs YHA-Bridge instead")
	// Hint that the toggle endpoint exists, so the user knows the daemon
	// is reachable and that this is a feature gap, not a connectivity issue.
	if *outFlag != "json" {
		fmt.Fprintln(os.Stderr, "       (only /v1/logging is available, and it is a feature toggle, not a log stream)")
	}
	return 1
}

func runLogsStatus(ctx context.Context, pf promptFlags) int {
	resp, err := getRequest(ctx, pf, "/v1/logging")
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha logs:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha logs:", err)
		return 1
	}
	if pf.out == "json" {
		os.Stdout.Write(body)
		if len(body) == 0 || body[len(body)-1] != '\n' {
			fmt.Println()
		}
		return 0
	}
	var parsed struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		fmt.Fprintln(os.Stderr, "yha logs: parse:", err)
		return 1
	}
	state := "disabled"
	if parsed.Enabled {
		state = "enabled"
	}
	fmt.Printf("api logging: %s\n", state)
	return 0
}

// probeTailEndpoint asks the daemon whether any of a handful of likely
// tail routes are reachable. Returns the first one that answers with a
// non-404/501 status. We use HEAD so we don't pull a giant body just to
// probe; if HEAD isn't supported we fall back to GET. Future-proofing —
// see the file-level note.
func probeTailEndpoint(ctx context.Context, pf promptFlags) (string, bool) {
	candidates := []string{
		"/v1/logging/tail",
		"/v1/logging/stream",
		"/v1/logs/tail",
		"/v1/logs",
	}
	for _, path := range candidates {
		// Short per-candidate ctx so a hung daemon doesn't burn the
		// whole 30s timeout on probes.
		probeCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
		req, err := http.NewRequestWithContext(probeCtx, "HEAD", urlFor(pf, path), nil)
		if err != nil {
			cancel()
			continue
		}
		if t := tokenFor(pf); t != "" {
			req.Header.Set("Authorization", "Bearer "+t)
		}
		resp, err := clientFor(pf).Do(req)
		cancel()
		if err != nil {
			continue
		}
		_ = resp.Body.Close()
		// 404/501 = not implemented; 405 = exists but no HEAD; anything
		// 2xx/3xx = it's there.
		if resp.StatusCode == 404 || resp.StatusCode == 501 {
			continue
		}
		return path, true
	}
	return "", false
}

// doTail fetches logs from a discovered tail endpoint. Currently
// unreachable in production (no endpoint exists), but kept ready so the
// user-facing flag surface doesn't change once a tail route lands.
func doTail(ctx context.Context, pf promptFlags, path string, follow bool, filter string, lines int) int {
	q := fmt.Sprintf("%s?lines=%d", path, lines)
	if follow {
		q += "&follow=1"
	}
	resp, err := getRequest(ctx, pf, q)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha logs:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		dumpErr(resp)
		return 1
	}
	// Stream line-by-line so --follow works; --filter is a plain
	// substring match, case-sensitive (matches grep-style use cases).
	br := bufio.NewReader(resp.Body)
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			if filter == "" || strings.Contains(line, filter) {
				_, _ = io.WriteString(os.Stdout, line)
			}
		}
		if err != nil {
			if err == io.EOF {
				return 0
			}
			fmt.Fprintln(os.Stderr, "yha logs:", err)
			return 1
		}
	}
}
