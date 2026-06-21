package main

// session.go — `yha session list|get|kill`. Bridge routes:
//   GET /v1/sessions/, GET /v1/sessions/<id>, DELETE /v1/sessions/<id>,
//   POST /v1/stop/<id>. `kill` defaults to POST /v1/stop (cancel stream);
//   --delete switches to DELETE /v1/sessions/<id>.

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

type sessionFlags struct {
	socket, url, token, tokenFile, out string
	timeout                            time.Duration
}

func (sf sessionFlags) toPF() promptFlags {
	return promptFlags{socket: sf.socket, url: sf.url, token: sf.token, tokenFile: sf.tokenFile, out: sf.out}
}

func newSessionFlagSet(name string) (*flag.FlagSet, *sessionFlags) {
	fs := flag.NewFlagSet("session "+name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	sf := &sessionFlags{}
	fs.StringVar(&sf.socket, "socket", "", "Unix socket path (default: discovered)")
	fs.StringVar(&sf.url, "url", os.Getenv("YHA_URL"), "remote yha-core URL")
	fs.StringVar(&sf.token, "token", os.Getenv("YHA_TOKEN"), "bearer token for --url")
	fs.StringVar(&sf.tokenFile, "token-file", "", "read bearer token from a file")
	fs.StringVar(&sf.out, "out", "text", "output mode: text | json")
	fs.DurationVar(&sf.timeout, "timeout", 30*time.Second, "request timeout")
	return fs, sf
}

func runSession(args []string) int {
	if len(args) == 0 {
		return runSessionList(nil)
	}
	switch args[0] {
	case "list":
		return runSessionList(args[1:])
	case "get":
		return runSessionGet(args[1:])
	case "kill":
		return runSessionKill(args[1:])
	case "help", "--help", "-h":
		printSessionHelp(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "yha session: unknown subcommand %q\n\n", args[0])
		printSessionHelp(os.Stderr)
		return 2
	}
}

// ── list ───────────────────────────────────────────────────────────────────

type sessionInfo struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	MessageCount int    `json:"messageCount"`
	LastUsed     int64  `json:"lastUsed"`
	IsRunning    bool   `json:"isRunning"`
}

func runSessionList(args []string) int {
	fs, sf := newSessionFlagSet("list")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	body, code := fetchBody(*sf, "GET", "/v1/sessions/", nil)
	if code != 0 {
		return code
	}
	if sf.out == "json" {
		writeJSONOut(body)
		return 0
	}
	var parsed struct {
		Sessions []sessionInfo `json:"sessions"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		fmt.Fprintln(os.Stderr, "yha session: parse:", err)
		return 1
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tNAME\tMESSAGES\tLAST USED")
	sort.Slice(parsed.Sessions, func(i, j int) bool { return parsed.Sessions[i].LastUsed > parsed.Sessions[j].LastUsed })
	now := time.Now()
	if len(parsed.Sessions) == 0 {
		fmt.Fprintln(tw, "-\t-\t-\t-")
	}
	for _, s := range parsed.Sessions {
		name := s.Name
		if name == "" {
			name = "(unnamed)"
		}
		if len(name) > 32 {
			name = name[:29] + "..."
		}
		fmt.Fprintf(tw, "%s\t%s\t%d\t%s\n", s.ID, name, s.MessageCount, humanAgo(s.LastUsed, now))
	}
	_ = tw.Flush()
	return 0
}

func humanAgo(ms int64, now time.Time) string {
	if ms <= 0 {
		return "-"
	}
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// ── get ────────────────────────────────────────────────────────────────────

type sessionMsg struct {
	Role   string `json:"role"`
	Text   any    `json:"text"`
	Blocks []struct {
		Content string `json:"content"`
		Text    string `json:"text"`
	} `json:"blocks"`
}

func runSessionGet(args []string) int {
	fs, sf := newSessionFlagSet("get")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) == 0 {
		fmt.Fprintln(os.Stderr, "yha session get: session id required")
		return 2
	}
	body, code := fetchBody(*sf, "GET", "/v1/sessions/"+rest[0], nil)
	if code != 0 {
		return code
	}
	if sf.out == "json" {
		writeJSONOut(body)
		return 0
	}
	// encoding/json matches lowercase bridge keys against the Go-cased
	// field names case-insensitively, so no per-field tags are needed.
	var p struct {
		Session struct {
			ID, Name, WorkingDir string
			Messages             []sessionMsg
			MessageCount         int
			CreatedAt, LastUsed  int64
			IsRunning            bool
		} `json:"session"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		fmt.Fprintln(os.Stderr, "yha session: parse:", err)
		return 1
	}
	s := p.Session
	fmt.Printf("id:          %s\nname:        %s\nmessages:    %d\ncreated:     %s\nlast used:   %s\n",
		s.ID, s.Name, s.MessageCount, fmtTime(s.CreatedAt), fmtTime(s.LastUsed))
	if s.WorkingDir != "" {
		fmt.Printf("working dir: %s\n", s.WorkingDir)
	}
	fmt.Printf("running:     %v\n", s.IsRunning)
	if n := len(s.Messages); n > 0 {
		start := 0
		if n > 3 {
			start = n - 3
		}
		fmt.Println("\nrecent messages:")
		for _, m := range s.Messages[start:] {
			fmt.Printf("  [%s] %s\n", m.Role, snippetFromMsg(m))
		}
	}
	return 0
}

func fmtTime(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04:05")
}

// snippetFromMsg pulls a single-line preview out of a session message.
// Bridge messages can carry text either as a string field or as a
// `blocks` array of {type, content|text} objects.
func snippetFromMsg(m sessionMsg) string {
	const maxLen = 100
	clean := func(s string) string {
		s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
		if len(s) > maxLen {
			s = s[:maxLen-3] + "..."
		}
		return s
	}
	if t, ok := m.Text.(string); ok && t != "" {
		return clean(t)
	}
	for _, b := range m.Blocks {
		if b.Content != "" {
			return clean(b.Content)
		}
		if b.Text != "" {
			return clean(b.Text)
		}
	}
	return "(no text)"
}

// ── kill ───────────────────────────────────────────────────────────────────

func runSessionKill(args []string) int {
	fs, sf := newSessionFlagSet("kill")
	deleteFlag := fs.Bool("delete", false, "DELETE the session instead of stopping the stream")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) == 0 {
		fmt.Fprintln(os.Stderr, "yha session kill: session id required")
		return 2
	}
	id := rest[0]
	verb, path := "POST", "/v1/stop/"+id
	if *deleteFlag {
		verb, path = "DELETE", "/v1/sessions/"+id
	}
	body, code := fetchBody(*sf, verb, path, map[string]any{})
	if code != 0 {
		return code
	}
	if sf.out == "json" {
		writeJSONOut(body)
		return 0
	}
	if *deleteFlag {
		fmt.Printf("deleted: %s\n", id)
		return 0
	}
	var parsed struct {
		Stopped bool `json:"stopped"`
	}
	_ = json.Unmarshal(body, &parsed)
	if parsed.Stopped {
		fmt.Printf("stopped: %s\n", id)
	} else {
		fmt.Printf("not running: %s\n", id)
	}
	return 0
}

// fetchBody is a per-subcommand wrapper around fetchSimple in http.go,
// honouring the local --timeout on sessionFlags.
func fetchBody(sf sessionFlags, verb, path string, body any) ([]byte, int) {
	ctx, cancel := context.WithTimeout(context.Background(), sf.timeout)
	defer cancel()
	return fetchSimple(ctx, sf.toPF(), "yha session", verb, path, body)
}

// printSessionHelp is shared with help.go's `yha help session`.
func printSessionHelp(w io.Writer) {
	fmt.Fprintln(w, sessionHelpText)
}

const sessionHelpText = `yha session — list / inspect / kill bridge sessions

Usage:
  yha session [list]              show session table (alias)
  yha session list                show session table
  yha session get <id>            full metadata + last 3 message snippets
  yha session kill <id>           stop the active stream (POST /v1/stop/<id>)
  yha session kill <id> --delete  delete the session (DELETE /v1/sessions/<id>)

Flags: --socket --url --token --token-file --out=text|json --timeout

Examples:
  yha session
  yha session get yha-abc123
  yha session kill yha-abc123
  yha session kill yha-abc123 --delete`
