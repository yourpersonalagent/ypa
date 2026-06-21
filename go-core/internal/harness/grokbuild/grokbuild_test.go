package grokbuild

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/yha/core/internal/stream"
)

// cutoffReader yields data once, then returns err (simulating grok's stdout
// being severed mid-turn: broken pipe / killed child).
type cutoffReader struct {
	data []byte
	err  error
	done bool
}

func (r *cutoffReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, r.err
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	if len(r.data) == 0 {
		r.done = true
	}
	return n, nil
}

func (r *cutoffReader) Close() error { return nil }

func newStreamerWithStdout(stdout io.ReadCloser) *Streamer {
	return &Streamer{
		runFn: func(ctx context.Context, opts SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, func() error, error) {
			return stdout, io.NopCloser(strings.NewReader("")), func() error { return nil }, func() error { return nil }, nil
		},
	}
}

func collectEmit(chunks *[]stream.Chunk) emitFn {
	return func(c stream.Chunk) { *chunks = append(*chunks, c) }
}

// A stream cut off mid-turn (non-EOF read error) must surface as an error —
// NOT a clean end_turn — even though partial text was buffered. This is the
// "grok started answering then nothing showed" failure: previously the turn
// was persisted as complete and the tail silently disappeared.
func TestRunInterruptedStreamSurfacesError(t *testing.T) {
	stdout := &cutoffReader{
		data: []byte(`{"type":"model.message","data":"partial answer so far"}` + "\n"),
		err:  io.ErrUnexpectedEOF,
	}
	s := newStreamerWithStdout(stdout)

	var chunks []stream.Chunk
	res, err := s.Run(context.Background(), runRequest{Prompt: "hi"}, collectEmit(&chunks))

	if err == nil {
		t.Fatal("interrupted stream must return an error, got nil")
	}
	if res.StopReason != "error" {
		t.Errorf("StopReason = %q, want \"error\"", res.StopReason)
	}
	if res.Text != "partial answer so far" {
		t.Errorf("partial text not preserved: %q", res.Text)
	}
	var sawErr, sawDone bool
	for _, c := range chunks {
		switch c.Type {
		case stream.ChunkTypeError:
			sawErr = true
		case stream.ChunkTypeDone:
			sawDone = true
		}
	}
	if !sawErr {
		t.Error("expected an error chunk to be emitted")
	}
	if sawDone {
		t.Error("must not emit a done chunk for an interrupted turn")
	}
}

// A single NDJSON line larger than the old 1 MiB bufio.Scanner cap must parse
// fully. The Scanner silently hit ErrTooLong and dropped the rest of the turn;
// the bufio.Reader grows to fit any line.
func TestRunOversizedLineParsesFully(t *testing.T) {
	big := strings.Repeat("x", 2*1024*1024) // 2 MiB, well past the old cap
	payload := `{"type":"model.message","data":"` + big + `"}` + "\n" +
		`{"type":"session.end","stopReason":"end_turn","sessionId":"s1"}` + "\n"
	s := newStreamerWithStdout(io.NopCloser(strings.NewReader(payload)))

	var chunks []stream.Chunk
	res, err := s.Run(context.Background(), runRequest{Prompt: "hi"}, collectEmit(&chunks))

	if err != nil {
		t.Fatalf("oversized line should parse cleanly, got error: %v", err)
	}
	if len(res.Text) != len(big) {
		t.Errorf("text length = %d, want %d (oversized line truncated?)", len(res.Text), len(big))
	}
	if res.StopReason != "end_turn" {
		t.Errorf("StopReason = %q, want \"end_turn\"", res.StopReason)
	}
	if res.SessionID != "s1" {
		t.Errorf("SessionID = %q, want \"s1\"", res.SessionID)
	}
}

// session.start is parsed but not emitted to the UI. It must still count as
// stdout activity so the startup watchdog does not kill a turn that is
// thinking silently after the CLI has connected.
func TestRunSessionStartCancelsStartupWatchdog(t *testing.T) {
	payload := `{"type":"session.start","sessionId":"s1"}` + "\n" +
		`{"type":"model.message","data":"hello"}` + "\n" +
		`{"type":"session.end","stopReason":"end_turn","sessionId":"s1"}` + "\n"
	s := newStreamerWithStdout(io.NopCloser(strings.NewReader(payload)))

	var chunks []stream.Chunk
	res, err := s.Run(context.Background(), runRequest{Prompt: "hi"}, collectEmit(&chunks))

	if err != nil {
		t.Fatalf("session.start-only preamble should not trip startup watchdog: %v", err)
	}
	if res.Text != "hello" {
		t.Errorf("text = %q, want hello", res.Text)
	}
}
