package tools

import (
	"context"
	"strings"
	"testing"
	"time"
)

func newTestExec(t *testing.T) *Executor {
	t.Helper()
	return New(t.TempDir(), nil, nil)
}

func TestBashRunHappy(t *testing.T) {
	e := newTestExec(t)
	res, err := e.Run(context.Background(), "Bash", map[string]any{
		"command": "echo hello",
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	if !strings.Contains(res.Content, "hello") {
		t.Errorf("expected 'hello' in content, got %q", res.Content)
	}
	if ec, _ := res.Meta["exit_code"].(int); ec != 0 {
		t.Errorf("expected exit_code=0, got %v", res.Meta["exit_code"])
	}
}

func TestBashRunNonZeroExit(t *testing.T) {
	e := newTestExec(t)
	res, _ := e.Run(context.Background(), "Bash", map[string]any{
		"command": "exit 42",
	})
	if res.OK {
		t.Error("expected OK=false on non-zero exit")
	}
	if ec, _ := res.Meta["exit_code"].(int); ec != 42 {
		t.Errorf("expected exit_code=42, got %v", res.Meta["exit_code"])
	}
}

func TestBashRunTimeoutKills(t *testing.T) {
	e := newTestExec(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	res, _ := e.Run(ctx, "Bash", map[string]any{
		"command": "sleep 5",
	})
	if res.OK {
		t.Error("expected OK=false on timeout")
	}
	if killed, _ := res.Meta["killed"].(bool); !killed {
		t.Error("expected meta.killed=true")
	}
}

func TestBashRunStdoutCap(t *testing.T) {
	e := newTestExec(t)
	// Generate ~16k of output; cap is 8k.
	res, _ := e.Run(context.Background(), "Bash", map[string]any{
		"command": "yes A | head -c 16000",
	})
	if len(res.Content) > outBufCap*2+200 { // some slack for stderr framing
		t.Errorf("output not capped: %d bytes", len(res.Content))
	}
}

func TestBashRunMissingCommand(t *testing.T) {
	e := newTestExec(t)
	res, _ := e.Run(context.Background(), "Bash", map[string]any{})
	if res.OK {
		t.Error("expected OK=false on missing command")
	}
}

func TestBashRunRejectsTraversalCWD(t *testing.T) {
	e := newTestExec(t)
	res, _ := e.Run(context.Background(), "Bash", map[string]any{
		"command": "echo hi",
		"cwd":     "../../../etc",
	})
	if res.OK {
		t.Error("expected OK=false on traversal cwd")
	}
}
