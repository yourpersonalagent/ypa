package tui

// activity.go — subscribes to GET /v1/activity/stream and turns the
// process-global "which sessions are busy right now" feed into tea.Msgs.
//
// The feed (go-core/internal/stream/route.go) sends an initial snapshot
// on connect, then a fresh `{"type":"activity","sessions":[...]}` frame
// only when the busy set or its counters change, plus a `{"_hb":<ms>}`
// heartbeat every 10s. Each frame's `sessions` array IS the complete set
// of streaming sessions — a session's ABSENCE means idle. So we replace
// our busy set wholesale on every `activity` frame and ignore `_hb`.
//
// Plumbing mirrors wire.go's pumpSSE/readNextChunk: a goroutine reads
// frames onto a channel and a re-issued blocking tea.Cmd hands each one
// to the bubbletea loop. On drop the channel closes, surfacing as
// activityClosedMsg so the root model reconnects on a short tea.Tick
// backoff (matches the frontend store's 2s self-heal).

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// activityReadyMsg hands the freshly-opened feed channel back to the root
// model so Update can stash it and start draining via readActivity.
type activityReadyMsg struct {
	ch chan tea.Msg
}

// activityBusyMsg carries the current busy set (session id → live meta)
// parsed from one `activity` frame. Presence is the whole signal.
type activityBusyMsg struct {
	busy map[string]activityMeta
}

// activityClosedMsg signals the feed dropped (EOF, transport error, or a
// daemon restart). The root model schedules a reconnect.
type activityClosedMsg struct{}

// activityMeta is the subset of the feed's per-session snapshot the TUI
// surfaces. Wire shape is stream.LiveSnapshot; we keep only what the
// sessions list + headline read and ignore the counters we don't show.
type activityMeta struct {
	SessionID string `json:"sessionId"`
	Model     string `json:"model"`
}

// activityReconnectDelay paces reconnect attempts after the feed drops.
// Mirrors the frontend sessionActivityStore's 2s backoff so a daemon
// bounce re-syncs the busy set within a couple of seconds.
const activityReconnectDelay = 2 * time.Second

// startActivity opens the feed in a goroutine and returns the channel via
// activityReadyMsg. The dial happens inside the pump (off the Update
// goroutine) so a slow or missing daemon never stalls the UI.
func startActivity(c *http.Client, base string, opts Options) tea.Cmd {
	return func() tea.Msg {
		ch := make(chan tea.Msg, 8)
		go pumpActivity(c, base, opts, ch)
		return activityReadyMsg{ch: ch}
	}
}

// readActivity blocks for the next feed message and returns it. The root
// model re-issues it after every activity msg so the loop keeps draining;
// a closed channel becomes activityClosedMsg.
func readActivity(ch chan tea.Msg) tea.Cmd {
	return func() tea.Msg {
		msg, ok := <-ch
		if !ok {
			return activityClosedMsg{}
		}
		return msg
	}
}

// pumpActivity dials the SSE feed and pushes one activityBusyMsg per
// `activity` frame, closing ch on any terminal condition. Runs in its own
// goroutine; the closed channel surfaces as activityClosedMsg.
func pumpActivity(c *http.Client, base string, opts Options, ch chan<- tea.Msg) {
	defer close(ch)

	resp, cancel, err := openActivityStream(c, base, opts)
	if err != nil {
		return
	}
	defer cancel()
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return
	}

	br := bufio.NewReader(resp.Body)
	var dataBuf strings.Builder
	flush := func() {
		if dataBuf.Len() == 0 {
			return
		}
		raw := dataBuf.String()
		dataBuf.Reset()
		var frame struct {
			Type     string         `json:"type"`
			Sessions []activityMeta `json:"sessions"`
		}
		if err := json.Unmarshal([]byte(raw), &frame); err != nil {
			return // tolerate a malformed frame rather than kill the feed
		}
		// Only `activity` frames carry session state; this also skips the
		// single-key `_hb` heartbeat the feed emits on an idle box.
		if frame.Type != "activity" {
			return
		}
		busy := make(map[string]activityMeta, len(frame.Sessions))
		for _, s := range frame.Sessions {
			if s.SessionID != "" {
				busy[s.SessionID] = s
			}
		}
		ch <- activityBusyMsg{busy: busy}
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			flush()
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			flush() // blank line terminates an SSE event
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
	}
}

// openActivityStream issues the long-lived GET. It clones the client with
// Timeout=0 because http.Client.Timeout caps the WHOLE request including
// the body read — a non-zero deadline (the TUI's default 10m chat timeout)
// would sever the feed on a fixed cadence. The cloned client shares the
// original transport, so unix-socket vs TCP wiring is preserved.
func openActivityStream(c *http.Client, base string, opts Options) (*http.Response, context.CancelFunc, error) {
	client := *c
	client.Timeout = 0
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/v1/activity/stream", nil)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	authHeader(req, opts)
	resp, err := client.Do(req)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	return resp, cancel, nil
}
