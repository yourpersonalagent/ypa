// Package mcp ports the MCP stdio protocol from
// bridge/modules/mcp-client/lib/protocol.ts.
//
// Wire format (per the MCP spec, same as Language Server Protocol):
//
//	Content-Length: 123\r\n
//	\r\n
//	<JSON body, exactly 123 bytes>
//
// JSON bodies are JSON-RPC 2.0. This package handles framing and the
// JSON-RPC envelope only; pool.go owns process lifecycle and the
// pending-request map keyed by message ID.
//
// The parser tolerates non-Content-Length headers (skips them) and
// short reads (blocks until the body is fully buffered). It does NOT
// tolerate frames with no Content-Length — that's a protocol error.
package mcp

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// ── JSON-RPC envelope ──────────────────────────────────────────────────────

// Request is the JSON-RPC 2.0 request shape used over MCP. Notifications
// (no response expected) leave ID zero — but MCP requests always have
// an ID, so callers should set one.
type Request struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// Response wraps either a Result or an Error. ID matches the Request
// it answers.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError mirrors the JSON-RPC error object.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("mcp rpc: %s (code %d)", e.Message, e.Code)
}

// ── Framing ────────────────────────────────────────────────────────────────

// Reader reads Content-Length-framed JSON bodies from an underlying
// stream. Safe for use by a single goroutine. Wrap your subprocess'
// stdout once with NewReader and call ReadFrame in a loop.
type Reader struct {
	br *bufio.Reader
}

// NewReader wraps r in a buffered reader sized for typical MCP frames
// (small JSON-RPC messages — 4 KiB default suffices).
func NewReader(r io.Reader) *Reader {
	return &Reader{br: bufio.NewReaderSize(r, 4*1024)}
}

// ReadFrame consumes one Content-Length-framed body and returns the raw
// JSON bytes. The headers are read and discarded; only Content-Length
// is honoured. Returns io.EOF when the stream closes between frames.
//
// On a partial frame (header complete, body short), ReadFrame blocks
// until the body fills — same shape as the JS parser's "wait until
// buf.length >= bodyStart + len" loop.
func (r *Reader) ReadFrame() ([]byte, error) {
	contentLength := -1
	for {
		line, err := r.br.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) && line == "" && contentLength < 0 {
				return nil, io.EOF
			}
			return nil, fmt.Errorf("mcp: read header: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break // end-of-headers blank line
		}
		if cl, ok := parseContentLength(line); ok {
			contentLength = cl
		}
		// Other headers (Content-Type, custom) are silently skipped.
	}
	if contentLength < 0 {
		return nil, errors.New("mcp: missing Content-Length header")
	}
	if contentLength == 0 {
		return []byte{}, nil
	}
	body := make([]byte, contentLength)
	if _, err := io.ReadFull(r.br, body); err != nil {
		return nil, fmt.Errorf("mcp: read body (%d bytes): %w", contentLength, err)
	}
	return body, nil
}

func parseContentLength(line string) (int, bool) {
	const prefix = "content-length:"
	if !strings.HasPrefix(strings.ToLower(line), prefix) {
		return 0, false
	}
	v := strings.TrimSpace(line[len(prefix):])
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// WriteFrame writes a Content-Length-framed JSON body to w. Caller
// holds the writer's mutex if multiple goroutines might write
// concurrently.
func WriteFrame(w io.Writer, body []byte) error {
	hdr := fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body))
	if _, err := io.WriteString(w, hdr); err != nil {
		return fmt.Errorf("mcp: write header: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("mcp: write body: %w", err)
	}
	return nil
}

// EncodeRequest is a convenience that marshals + frames in one call.
func EncodeRequest(w io.Writer, req Request) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("mcp: marshal request: %w", err)
	}
	return WriteFrame(w, body)
}
