package main

// rewind.go — CLI for the yha-rewind safety-net service.
//
// `yha rewind` talks to the standalone yha-rewind daemon over loopback
// (default 127.0.0.1:8445). Override with --rewind-url= or
// $YHA_REWIND_URL when running against a non-default port / host.
//
// Subcommands:
//   yha rewind list  [--limit N]              # newest-first edit records
//   yha rewind show  <id>                     # before/after diff
//   yha rewind apply <id>                     # restore (writes BEFORE back)
//   yha rewind gc    [--dry] [--min-age=Ns]   # mark-and-sweep CAS

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const defaultRewindURL = "http://127.0.0.1:8445"

func rewindURL(override string) string {
	if override != "" {
		return strings.TrimRight(override, "/")
	}
	if env := os.Getenv("YHA_REWIND_URL"); env != "" {
		return strings.TrimRight(env, "/")
	}
	return defaultRewindURL
}

func runRewind(args []string) int {
	if len(args) == 0 {
		printRewindHelp(os.Stdout)
		return 0
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "list":
		return runRewindList(rest)
	case "show":
		return runRewindShow(rest)
	case "apply", "restore":
		return runRewindApply(rest)
	case "gc":
		return runRewindGC(rest)
	case "help", "--help", "-h":
		printRewindHelp(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "yha rewind: unknown subcommand %q\n\n", sub)
		printRewindHelp(os.Stderr)
		return 2
	}
}

func printRewindHelp(w io.Writer) {
	fmt.Fprintln(w, `yha rewind — interact with the rewind safety-net service.

Usage:
  yha rewind list  [--limit N]              list recent edit records (newest first)
  yha rewind show  <id>                     print before/after for a single record
  yha rewind apply <id>                     restore the BEFORE content for a record
  yha rewind gc    [--dry] [--min-age=Ns]   garbage-collect orphaned blobs

Flags (any subcommand):
  --rewind-url=URL    override the rewind service base URL (default
                      $YHA_REWIND_URL or http://127.0.0.1:8445)
  --timeout=DURATION  request timeout (default 30s)`)
}

// ── list ──────────────────────────────────────────────────────────────────

func runRewindList(args []string) int {
	fs := flag.NewFlagSet("rewind list", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	url := fs.String("rewind-url", "", "rewind service base URL (overrides $YHA_REWIND_URL)")
	limit := fs.Int("limit", 20, "max records to print")
	asJSON := fs.Bool("json", false, "emit the raw JSON response from /api/edits")
	timeout := fs.Duration("timeout", 30*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, *timeout)
	defer cancelT()

	body, err := rewindGet(ctx, rewindURL(*url), fmt.Sprintf("/api/edits?limit=%d", *limit))
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha rewind list:", err)
		return 1
	}
	if *asJSON {
		writeJSONOut(body)
		return 0
	}
	var doc struct {
		Edits []struct {
			ID          string  `json:"id"`
			TS          int64   `json:"ts"`
			Trigger     string  `json:"trigger"`
			Module      string  `json:"module"`
			AgentTurnID *string `json:"agent_turn_id"`
			Files       []struct {
				Path string `json:"path"`
				Op   string `json:"op"`
			} `json:"files"`
		} `json:"edits"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		fmt.Fprintln(os.Stderr, "yha rewind list: parse:", err)
		return 1
	}
	if len(doc.Edits) == 0 {
		fmt.Println("(no edit records)")
		return 0
	}
	for _, e := range doc.Edits {
		ts := time.UnixMilli(e.TS).UTC().Format("2006-01-02 15:04:05")
		turn := "-"
		if e.AgentTurnID != nil && *e.AgentTurnID != "" {
			turn = *e.AgentTurnID
		}
		fmt.Printf("%s  %s  %-10s  %-32s  turn=%s  files=%d\n",
			e.ID[:8], ts, e.Trigger, e.Module, turn, len(e.Files))
		for _, f := range e.Files {
			fmt.Printf("    %s %s\n", f.Op, f.Path)
		}
	}
	return 0
}

// ── show ──────────────────────────────────────────────────────────────────

func runRewindShow(args []string) int {
	fs := flag.NewFlagSet("rewind show", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	url := fs.String("rewind-url", "", "rewind service base URL (overrides $YHA_REWIND_URL)")
	asJSON := fs.Bool("json", false, "emit the raw JSON response from /api/diff/<id>")
	timeout := fs.Duration("timeout", 30*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "yha rewind show: <id> required")
		return 2
	}
	id := fs.Arg(0)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, *timeout)
	defer cancelT()

	body, err := rewindGet(ctx, rewindURL(*url), "/api/diff/"+id)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha rewind show:", err)
		return 1
	}
	if *asJSON {
		writeJSONOut(body)
		return 0
	}
	var doc struct {
		ID     string `json:"id"`
		Module string `json:"module"`
		Files  []struct {
			Path   string  `json:"path"`
			Op     string  `json:"op"`
			Before *string `json:"before"`
			After  *string `json:"after"`
		} `json:"files"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		fmt.Fprintln(os.Stderr, "yha rewind show: parse:", err)
		return 1
	}
	fmt.Printf("record %s — module %s — %d files\n", doc.ID, doc.Module, len(doc.Files))
	for _, f := range doc.Files {
		fmt.Printf("\n=== %s  (%s) ===\n", f.Path, f.Op)
		before := ""
		if f.Before != nil {
			before = *f.Before
		}
		after := ""
		if f.After != nil {
			after = *f.After
		}
		fmt.Println("--- before ---")
		fmt.Print(before)
		if !strings.HasSuffix(before, "\n") {
			fmt.Println()
		}
		fmt.Println("--- after ---")
		fmt.Print(after)
		if !strings.HasSuffix(after, "\n") {
			fmt.Println()
		}
	}
	return 0
}

// ── apply ─────────────────────────────────────────────────────────────────

func runRewindApply(args []string) int {
	fs := flag.NewFlagSet("rewind apply", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	url := fs.String("rewind-url", "", "rewind service base URL (overrides $YHA_REWIND_URL)")
	yes := fs.Bool("yes", false, "skip the confirmation prompt")
	timeout := fs.Duration("timeout", 60*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "yha rewind apply: <id> required")
		return 2
	}
	id := fs.Arg(0)
	if !*yes && !isPipedStdin() {
		fmt.Fprintf(os.Stderr, "Restore edit %s? This writes the BEFORE content back to disk. [y/N] ", id)
		var line string
		fmt.Scanln(&line)
		if strings.ToLower(strings.TrimSpace(line)) != "y" {
			fmt.Fprintln(os.Stderr, "aborted")
			return 1
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, *timeout)
	defer cancelT()

	body, err := rewindPost(ctx, rewindURL(*url), "/api/restore/"+id, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha rewind apply:", err)
		return 1
	}
	var doc struct {
		ID      string `json:"id"`
		Results []struct {
			Path string `json:"path"`
			Op   string `json:"op"`
			OK   bool   `json:"ok"`
			Err  string `json:"err"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		fmt.Fprintln(os.Stderr, "yha rewind apply: parse:", err)
		return 1
	}
	okN, errN := 0, 0
	for _, r := range doc.Results {
		if r.OK {
			okN++
			fmt.Printf("  OK   %s %s\n", r.Op, r.Path)
		} else {
			errN++
			fmt.Printf("  FAIL %s %s — %s\n", r.Op, r.Path, r.Err)
		}
	}
	fmt.Printf("\nrestored %s: %d OK, %d failed\n", doc.ID, okN, errN)
	if errN > 0 {
		return 1
	}
	return 0
}

// ── gc ────────────────────────────────────────────────────────────────────

func runRewindGC(args []string) int {
	fs := flag.NewFlagSet("rewind gc", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	url := fs.String("rewind-url", "", "rewind service base URL (overrides $YHA_REWIND_URL)")
	dry := fs.Bool("dry", false, "report what would be swept without deleting")
	minAge := fs.Int64("min-age", -1, "min blob age in seconds before sweeping (default: service default)")
	timeout := fs.Duration("timeout", 5*time.Minute, "request timeout (GC can be slow on big stores)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	q := ""
	if *dry {
		q = "?dry=1"
	}
	if *minAge >= 0 {
		if q == "" {
			q = "?"
		} else {
			q += "&"
		}
		q += fmt.Sprintf("min_age=%d", *minAge)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, *timeout)
	defer cancelT()

	body, err := rewindPost(ctx, rewindURL(*url), "/api/gc"+q, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha rewind gc:", err)
		return 1
	}
	var stats struct {
		Apply         bool   `json:"apply"`
		MinAgeSeconds int64  `json:"min_age_seconds"`
		LiveHashes    int    `json:"live_hashes"`
		Scanned       int    `json:"scanned"`
		Kept          int    `json:"kept"`
		KeptBytes     int64  `json:"kept_bytes"`
		Swept         int    `json:"swept"`
		SweptBytes    int64  `json:"swept_bytes"`
		SweptTmp      int    `json:"swept_tmp"`
		SweptTmpBytes int64  `json:"swept_tmp_bytes"`
		TooYoung      int    `json:"too_young"`
		Errors        int    `json:"errors"`
		DurationMs    int64  `json:"duration_ms"`
		Error         string `json:"error"`
	}
	if err := json.Unmarshal(body, &stats); err != nil {
		fmt.Fprintln(os.Stderr, "yha rewind gc: parse:", err)
		return 1
	}
	if stats.Error != "" {
		fmt.Fprintln(os.Stderr, "yha rewind gc:", stats.Error)
		return 1
	}
	mode := "APPLY"
	if !stats.Apply {
		mode = "DRY"
	}
	fmt.Printf("yha-rewind-gc — %s — min-age=%ds  live=%d  duration=%dms\n",
		mode, stats.MinAgeSeconds, stats.LiveHashes, stats.DurationMs)
	fmt.Printf("  scanned:     %d\n", stats.Scanned)
	fmt.Printf("  kept:        %d (%s)\n", stats.Kept, formatBytes(stats.KeptBytes))
	fmt.Printf("  swept:       %d (%s)%s\n", stats.Swept, formatBytes(stats.SweptBytes), dryNote(stats.Apply))
	fmt.Printf("  swept (tmp): %d (%s)%s\n", stats.SweptTmp, formatBytes(stats.SweptTmpBytes), dryNote(stats.Apply))
	fmt.Printf("  too young:   %d  (< %ds old, kept for safety)\n", stats.TooYoung, stats.MinAgeSeconds)
	if stats.Errors > 0 {
		fmt.Printf("  errors:      %d\n", stats.Errors)
	}
	return 0
}

func dryNote(apply bool) string {
	if apply {
		return ""
	}
	return "  [dry run — not deleted]"
}

func formatBytes(n int64) string {
	const k = 1024.0
	v := float64(n)
	units := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	for v >= k && i < len(units)-1 {
		v /= k
		i++
	}
	return fmt.Sprintf("%.2f %s", v, units[i])
}

// ── HTTP helpers (loopback, no auth) ──────────────────────────────────────

func rewindGet(ctx context.Context, base, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return nil, err
	}
	return rewindDo(req)
}

func rewindPost(ctx context.Context, base, path string, body io.Reader) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return rewindDo(req)
}

func rewindDo(req *http.Request) ([]byte, error) {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return body, fmt.Errorf("HTTP %d %s — %s",
			resp.StatusCode, resp.Status, strings.TrimSpace(string(body)))
	}
	return body, nil
}
