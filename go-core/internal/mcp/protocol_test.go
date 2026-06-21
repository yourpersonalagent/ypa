package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestWriteFrameThenReadFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
	if err := WriteFrame(&buf, body); err != nil {
		t.Fatalf("write: %v", err)
	}
	r := NewReader(&buf)
	got, err := r.ReadFrame()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("round-trip body = %q, want %q", got, body)
	}
}

func TestReaderHandlesMultipleFrames(t *testing.T) {
	var buf bytes.Buffer
	for i, body := range [][]byte{
		[]byte(`{"id":1}`),
		[]byte(`{"id":2,"big":"` + strings.Repeat("x", 5_000) + `"}`),
		[]byte(`{}`),
	} {
		if err := WriteFrame(&buf, body); err != nil {
			t.Fatalf("write frame %d: %v", i, err)
		}
	}
	r := NewReader(&buf)
	for i := 0; i < 3; i++ {
		got, err := r.ReadFrame()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if len(got) == 0 && i != 2 {
			t.Errorf("frame %d unexpectedly empty", i)
		}
	}
	// Fourth read hits EOF cleanly.
	if _, err := r.ReadFrame(); !errors.Is(err, io.EOF) {
		t.Errorf("after stream end: got %v, want io.EOF", err)
	}
}

func TestReaderTolerantOfExtraHeaders(t *testing.T) {
	raw := "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n" +
		"Content-Length: 7\r\n" +
		"\r\n" +
		`{"x":1}`
	r := NewReader(strings.NewReader(raw))
	got, err := r.ReadFrame()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != `{"x":1}` {
		t.Errorf("body = %q, want %q", got, `{"x":1}`)
	}
}

func TestReaderRejectsMissingContentLength(t *testing.T) {
	raw := "X-Custom: 42\r\n\r\n{}"
	r := NewReader(strings.NewReader(raw))
	_, err := r.ReadFrame()
	if err == nil {
		t.Error("expected error on missing Content-Length")
	}
}

func TestReaderHandlesShortBodyAcrossReads(t *testing.T) {
	body := []byte(`{"id":1,"method":"x"}`)
	pr, pw := io.Pipe()
	go func() {
		// Write header first, then body in two chunks with a gap. The
		// reader must wait for the full body via io.ReadFull.
		_, _ = pw.Write([]byte("Content-Length: 21\r\n\r\n"))
		_, _ = pw.Write(body[:10])
		_, _ = pw.Write(body[10:])
		_ = pw.Close()
	}()
	r := NewReader(pr)
	got, err := r.ReadFrame()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("body = %q, want %q", got, body)
	}
}

func TestEncodeRequestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	req := Request{
		JSONRPC: "2.0",
		ID:      42,
		Method:  "tools/call",
		Params:  map[string]any{"name": "Bash", "arguments": map[string]any{"command": "ls"}},
	}
	if err := EncodeRequest(&buf, req); err != nil {
		t.Fatalf("encode: %v", err)
	}
	r := NewReader(&buf)
	body, err := r.ReadFrame()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got Request
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ID != 42 || got.Method != "tools/call" {
		t.Errorf("decoded mismatch: %+v", got)
	}
}

func TestParseContentLengthCaseInsensitive(t *testing.T) {
	if _, ok := parseContentLength("CONTENT-LENGTH: 7"); !ok {
		t.Error("uppercase header rejected")
	}
	if _, ok := parseContentLength("content-length: 7"); !ok {
		t.Error("lowercase header rejected")
	}
	if _, ok := parseContentLength("X-Content-Length: 7"); ok {
		t.Error("misnamed header should not match")
	}
}

func TestRPCErrorFormatting(t *testing.T) {
	e := &RPCError{Code: -32601, Message: "method not found"}
	want := "mcp rpc: method not found (code -32601)"
	if got := e.Error(); got != want {
		t.Errorf("err format = %q, want %q", got, want)
	}
}
