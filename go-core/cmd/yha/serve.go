package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type serveCLIFlags struct {
	profile string
	cmdLine string
	ttl     time.Duration
	manual  bool
	share   bool
	out     string
	socket  string
	url     string
	token   string
	tokenFile string
	timeout time.Duration
}

type serveResp struct {
	Success bool            `json:"success"`
	Error   string          `json:"error"`
	Entry   json.RawMessage `json:"entry"`
	Share   json.RawMessage `json:"share"`
}

func runServe(args []string) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printServeHelp(os.Stdout)
		return 0
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "start":
		return runServeStart(rest)
	case "list":
		return runServeList(rest)
	case "stop":
		if len(rest) < 1 { fmt.Fprintln(os.Stderr, "yha serve stop: id required"); return 2 }
		return runServePostNoBody(rest[1:], "stop", "/v1/serve/stop/"+url.PathEscape(rest[0]))
	case "share":
		if len(rest) < 1 { fmt.Fprintln(os.Stderr, "yha serve share: id required"); return 2 }
		return runServeShare(rest[0], rest[1:])
	case "revoke":
		if len(rest) < 1 { fmt.Fprintln(os.Stderr, "yha serve revoke: token required"); return 2 }
		return runServePostNoBody(rest[1:], "revoke", "/v1/serve/shares/"+url.PathEscape(rest[0])+"/revoke")
	default:
		fmt.Fprintf(os.Stderr, "yha serve: unknown subcommand %q\n", sub)
		return 2
	}
}

func serveFlags(name string, args []string) (*flag.FlagSet, *serveCLIFlags) {
	fs := flag.NewFlagSet("serve "+name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	f := &serveCLIFlags{ttl: time.Hour, out: "text", timeout: 30 * time.Second, url: os.Getenv("YHA_URL"), token: os.Getenv("YHA_TOKEN")}
	fs.StringVar(&f.profile, "profile", "static", "profile: static | python | node | php | custom")
	fs.StringVar(&f.cmdLine, "cmd", "", "custom command; $PORT is injected")
	fs.DurationVar(&f.ttl, "ttl", time.Hour, "lifetime before auto-stop/share expiry")
	fs.BoolVar(&f.manual, "manual", false, "no TTL; manual stop/revoke only")
	fs.BoolVar(&f.share, "share", false, "create a public share link after start")
	fs.StringVar(&f.out, "out", "text", "output: text | json")
	fs.StringVar(&f.socket, "socket", "", "Unix socket path")
	fs.StringVar(&f.url, "url", os.Getenv("YHA_URL"), "remote yha-core URL")
	fs.StringVar(&f.token, "token", os.Getenv("YHA_TOKEN"), "bearer token")
	fs.StringVar(&f.tokenFile, "token-file", "", "read bearer token from file")
	fs.DurationVar(&f.timeout, "timeout", 30*time.Second, "request timeout")
	return fs, f
}

func promptFromServe(f *serveCLIFlags) promptFlags {
	return promptFlags{socket: f.socket, url: f.url, token: f.token, tokenFile: f.tokenFile, timeout: f.timeout}
}

func ttlValue(f *serveCLIFlags) any {
	if f.manual { return nil }
	return int64(f.ttl / time.Millisecond)
}

func runServeStart(args []string) int {
	fs, f := serveFlags("start", args)
	if err := fs.Parse(args); err != nil { return 2 }
	cwd := "."
	if fs.NArg() > 0 { cwd = fs.Arg(0) }
	abs, err := filepath.Abs(cwd)
	if err != nil { fmt.Fprintln(os.Stderr, "yha serve start:", err); return 1 }
	ctx, cancel := context.WithTimeout(context.Background(), f.timeout); defer cancel()
	body := map[string]any{"cwd": abs, "profile": f.profile, "cmdLine": f.cmdLine, "ttlMs": ttlValue(f), "keepAlive": f.manual}
	buf, code := fetchSimple(ctx, promptFromServe(f), "yha serve start", "POST", "/v1/serve/start", body)
	if code != 0 { return code }
	if f.share {
		var sr serveResp; _ = json.Unmarshal(buf, &sr)
		var entry struct{ ID string `json:"id"` }; _ = json.Unmarshal(sr.Entry, &entry)
		if entry.ID != "" { _ = runServeShareWithFlags(ctx, f, entry.ID) }
	}
	return servePrint(buf, f.out)
}

func runServeList(args []string) int {
	fs, f := serveFlags("list", args)
	if err := fs.Parse(args); err != nil { return 2 }
	ctx, cancel := context.WithTimeout(context.Background(), f.timeout); defer cancel()
	buf, code := fetchSimple(ctx, promptFromServe(f), "yha serve list", "GET", "/v1/serve/status", nil)
	if code != 0 { return code }
	return servePrint(buf, f.out)
}

func runServeShare(id string, args []string) int {
	fs, f := serveFlags("share", args)
	if err := fs.Parse(args); err != nil { return 2 }
	ctx, cancel := context.WithTimeout(context.Background(), f.timeout); defer cancel()
	buf, code := fetchSimple(ctx, promptFromServe(f), "yha serve share", "POST", "/v1/serve/share/"+url.PathEscape(id), map[string]any{"ttlMs": ttlValue(f)})
	if code != 0 { return code }
	return servePrint(buf, f.out)
}

func runServeShareWithFlags(ctx context.Context, f *serveCLIFlags, id string) int {
	buf, code := fetchSimple(ctx, promptFromServe(f), "yha serve share", "POST", "/v1/serve/share/"+url.PathEscape(id), map[string]any{"ttlMs": ttlValue(f)})
	if code == 0 && f.out != "json" { servePrint(buf, "text") }
	return code
}

func runServePostNoBody(args []string, label, path string) int {
	fs, f := serveFlags(label, args)
	if err := fs.Parse(args); err != nil { return 2 }
	ctx, cancel := context.WithTimeout(context.Background(), f.timeout); defer cancel()
	buf, code := fetchSimple(ctx, promptFromServe(f), "yha serve "+label, "POST", path, map[string]any{})
	if code != 0 { return code }
	return servePrint(buf, f.out)
}

func servePrint(buf []byte, out string) int {
	if out == "json" { writeJSONOut(buf); return 0 }
	var r serveResp
	if err := json.Unmarshal(buf, &r); err != nil { fmt.Println(string(buf)); return 0 }
	if len(r.Entry) > 0 && string(r.Entry) != "null" {
		var e struct{ ID, Profile, ProxyPath string; Port int }
		_ = json.Unmarshal(r.Entry, &e)
		fmt.Printf("serve %s %s %s", e.ID, e.Profile, e.ProxyPath)
		if e.Port > 0 { fmt.Printf(" :%d", e.Port) }
		fmt.Println()
		return 0
	}
	if len(r.Share) > 0 && string(r.Share) != "null" {
		var sh struct{ Token string `json:"token"` }
		_ = json.Unmarshal(r.Share, &sh)
		fmt.Println("share /share/" + sh.Token + "/")
		return 0
	}
	compact := strings.TrimSpace(string(buf))
	fmt.Println(compact)
	return 0
}

func printServeHelp(w *os.File) {
	fmt.Fprint(w, `yha serve — manage per-CWD preview servers

Usage:
  yha serve start [DIR] [--profile=static] [--ttl=1h] [--share]
  yha serve list
  yha serve stop <id>
  yha serve share <id> [--ttl=1h]
  yha serve revoke <token>

Examples:
  yha serve start .
  yha serve start ./site --profile=static --share --ttl=6h
  yha serve start . --profile=custom --cmd='npx vite --host 127.0.0.1 --port $PORT'
`)
}
