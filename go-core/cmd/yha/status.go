package main

// status.go — `yha status` subcommand. Hits the daemon's /healthz and
// reports the X-Yha-Core header so users can tell whether they hit the
// Go core directly or fell through its reverse proxy to Node.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

func runStatus(args []string) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	socket := fs.String("socket", "", "Unix socket path")
	url := fs.String("url", os.Getenv("YHA_URL"), "remote yha-core URL")
	out := fs.String("out", "text", "output mode: text | json")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	pf := promptFlags{socket: *socket, url: *url, out: *out, token: os.Getenv("YHA_TOKEN")}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp, err := getRequest(ctx, pf, "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha status:", err)
		return 1
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	xCore := resp.Header.Get("X-Yha-Core")
	switch *out {
	case "json":
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"status":     resp.StatusCode,
			"x-yha-core": xCore,
			"body":       strings.TrimSpace(string(body)),
		})
	default:
		fmt.Printf("status: %d\n", resp.StatusCode)
		fmt.Printf("body:   %s\n", strings.TrimSpace(string(body)))
		switch xCore {
		case "native":
			fmt.Println("served-by: yha-core (Go-native handler)")
		case "proxy":
			fmt.Println("served-by: yha-core (reverse proxy → Node)")
		case "":
			fmt.Println("served-by: Node bridge directly (yha-core not in path)")
		default:
			fmt.Printf("served-by: yha-core (%s)\n", xCore)
		}
	}
	if resp.StatusCode >= 300 {
		return 1
	}
	return 0
}
