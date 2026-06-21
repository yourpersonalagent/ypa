package tuid

// client.go — shared client for talking to the YHA-TUI-Daemon over its
// unix socket. Used by:
//   - the `yha cmd` non-interactive subcommand
//   - the bridge HTTP shim's daemon hop (via stdin/stdout pipe)
//   - the new TUI viewer panes (to come)
//
// Single connection, single goroutine, synchronous request/response
// model where applicable. Streaming subscribes hand the caller a
// channel of envelopes and a Close func.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/paths"
)

// Client wraps a single unix-socket connection to the daemon.
type Client struct {
	conn   net.Conn
	enc    *bufio.Writer
	dec    *bufio.Reader

	writeMu sync.Mutex

	mu     sync.Mutex
	wait   map[string]chan Envelope // id → response channel
	subs   map[string]chan Envelope // jobID → log-chunk fanout
	closed atomic.Bool
	closeC chan struct{}
}

// Dial connects to the daemon's unix socket. Uses paths.TUISocketPath()
// unless overridden.
func Dial(socketPath string) (*Client, error) {
	if socketPath == "" {
		socketPath = paths.TUISocketPath()
	}
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", socketPath, err)
	}
	c := &Client{
		conn:   conn,
		enc:    bufio.NewWriter(conn),
		dec:    bufio.NewReader(conn),
		wait:   make(map[string]chan Envelope),
		subs:   make(map[string]chan Envelope),
		closeC: make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

// Close terminates the connection. Idempotent.
func (c *Client) Close() error {
	if !c.closed.CompareAndSwap(false, true) {
		return nil
	}
	close(c.closeC)
	err := c.conn.Close()
	c.mu.Lock()
	for _, ch := range c.wait {
		close(ch)
	}
	c.wait = map[string]chan Envelope{}
	for _, ch := range c.subs {
		close(ch)
	}
	c.subs = map[string]chan Envelope{}
	c.mu.Unlock()
	return err
}

func (c *Client) readLoop() {
	defer c.Close()
	for {
		line, err := c.dec.ReadBytes('\n')
		if err != nil {
			return
		}
		var env Envelope
		if jerr := json.Unmarshal(bytesTrim(line), &env); jerr != nil {
			continue
		}
		switch env.Op {
		case OpLogChunk, OpJobStarted, OpJobEnded:
			// Push to job subscribers if any.
			c.mu.Lock()
			if ch, ok := c.subs[env.JobID]; ok {
				select {
				case ch <- env:
				default:
				}
			}
			c.mu.Unlock()
			// Fall through — also resolve a correlated request (rare;
			// usually broadcasts have no id, but tolerate it).
		}
		if env.ID == "" {
			continue
		}
		c.mu.Lock()
		if ch, ok := c.wait[env.ID]; ok {
			select {
			case ch <- env:
			default:
			}
			delete(c.wait, env.ID)
		}
		c.mu.Unlock()
	}
}

// send writes an envelope; threadsafe via writeMu.
func (c *Client) send(env Envelope) error {
	if c.closed.Load() {
		return errors.New("client closed")
	}
	b, err := env.MarshalLine()
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.enc.Write(b); err != nil {
		return err
	}
	return c.enc.Flush()
}

// request sends an envelope and waits for the correlated response. id
// is auto-generated if env.ID is empty.
func (c *Client) request(ctx context.Context, env Envelope) (Envelope, error) {
	if env.ID == "" {
		env.ID = fmt.Sprintf("r-%d", time.Now().UnixNano())
	}
	ch := make(chan Envelope, 1)
	c.mu.Lock()
	c.wait[env.ID] = ch
	c.mu.Unlock()
	if err := c.send(env); err != nil {
		c.mu.Lock()
		delete(c.wait, env.ID)
		c.mu.Unlock()
		return Envelope{}, err
	}
	select {
	case resp := <-ch:
		return resp, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.wait, env.ID)
		c.mu.Unlock()
		return Envelope{}, ctx.Err()
	case <-c.closeC:
		return Envelope{}, errors.New("connection closed")
	}
}

// ── high-level helpers ──────────────────────────────────────────────────

// Ping returns nil on success.
func (c *Client) Ping(ctx context.Context) error {
	resp, err := c.request(ctx, Envelope{Op: OpPing})
	if err != nil {
		return err
	}
	if resp.Op != OpPong {
		return fmt.Errorf("unexpected reply op: %s", resp.Op)
	}
	return nil
}

// Status returns the current cached snapshot.
func (c *Client) Status(ctx context.Context) (*StatusSnap, error) {
	resp, err := c.request(ctx, Envelope{Op: OpStatus})
	if err != nil {
		return nil, err
	}
	if resp.Op == OpError {
		return nil, errors.New(resp.Err)
	}
	return resp.Status, nil
}

// ListJobs returns every known job (running + recent).
func (c *Client) ListJobs(ctx context.Context) ([]JobInfo, error) {
	resp, err := c.request(ctx, Envelope{Op: OpListJobs})
	if err != nil {
		return nil, err
	}
	if resp.Op == OpError {
		return nil, errors.New(resp.Err)
	}
	return resp.Jobs, nil
}

// RunCommand spawns a command and returns the job_id. Does NOT wait
// for the job to finish; use SubscribeJob / WaitJob for that.
func (c *Client) RunCommand(ctx context.Context, cmd string, args []string, origin string) (string, error) {
	resp, err := c.request(ctx, Envelope{
		Op:     OpCmd,
		Cmd:    cmd,
		Args:   args,
		Origin: origin,
	})
	if err != nil {
		return "", err
	}
	if resp.Op == OpError {
		return "", errors.New(resp.Err)
	}
	return resp.JobID, nil
}

// SubscribeJob returns a channel that receives log-chunk + job-ended
// envelopes for the job. since is the byte offset to replay from.
// Caller MUST call the returned cancel() to unsubscribe.
func (c *Client) SubscribeJob(ctx context.Context, jobID string, since int64) (<-chan Envelope, func(), error) {
	ch := make(chan Envelope, 64)
	c.mu.Lock()
	c.subs[jobID] = ch
	c.mu.Unlock()
	if _, err := c.request(ctx, Envelope{
		Op:    OpSubscribeJob,
		JobID: jobID,
		Since: since,
	}); err != nil {
		c.mu.Lock()
		delete(c.subs, jobID)
		c.mu.Unlock()
		return nil, nil, err
	}
	cancel := func() {
		c.mu.Lock()
		delete(c.subs, jobID)
		c.mu.Unlock()
		_, _ = c.request(context.Background(), Envelope{
			Op:    OpUnsubscribeJob,
			JobID: jobID,
		})
	}
	return ch, cancel, nil
}
