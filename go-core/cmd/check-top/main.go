package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/yha/core/internal/tuid"
)

func main() {
	c, err := tuid.Dial("")
	if err != nil {
		fmt.Fprintln(os.Stderr, "dial:", err)
		os.Exit(1)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	snap, err := c.Status(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "status:", err)
		os.Exit(1)
	}
	fmt.Printf("runtime: mode=%s backend=%s use_dist=%v source=%s\n",
		snap.Runtime.Mode, snap.Runtime.Backend, snap.Runtime.UseDist, snap.Runtime.Source)
	fmt.Printf("\ntop processes (%d):\n", len(snap.Top))
	for _, p := range snap.Top {
		tag := "  "
		if p.Tag == "yha" {
			tag = "Y "
		}
		fmt.Printf("  %s PID=%-7d %5.1f%%  %4dMB  %-10s %s\n",
			tag, p.PID, p.CPU, p.MemMB, p.Cmd, p.Args)
	}
	if snap.TopError != "" {
		fmt.Println("top_error:", snap.TopError)
	}
	out, _ := json.MarshalIndent(snap.Top, "", "  ")
	fmt.Println("\nraw json:")
	fmt.Println(string(out))
}
