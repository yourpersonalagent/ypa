package tuid

// daemon.go — the unix-socket server. One Daemon owns:
//
//   - a Registry (jobs + log fan-out)
//   - a Sampler (cached pm2/git/tailscale snapshot)
//   - a listener at bridge/state/yha-tui/daemon.sock
//
// Each client connection runs handleConn in its own goroutine. The
// protocol is newline-delimited JSON envelopes — see protocol.go.
//
// Concurrency model: each connection has its own writer goroutine that
// drains a buffered channel of envelopes. Reader pushes responses onto
// that channel; the per-job subscription goroutine also pushes onto it.
// Single writer per connection avoids interleaved framing on the wire.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/yha/core/internal/paths"
)

// Daemon is the long-running TUI orchestration process.
type Daemon struct {
	Registry *Registry
	Sampler  *Sampler

	socketPath string
	listener   net.Listener
	pid        int

	mu      sync.Mutex
	closing bool
}

// New constructs a Daemon ready to Serve. Reconciles orphans from the
// previous run before returning so list-jobs surfaces them immediately.
func New() (*Daemon, error) {
	reg, err := NewRegistry()
	if err != nil {
		return nil, err
	}
	if err := reg.Reconcile(); err != nil {
		// Reconcile is best-effort — log via stderr but keep going.
		fmt.Fprintln(os.Stderr, "yha-tui-daemon: reconcile:", err)
	}
	sampler := NewSampler()
	sampler.Start()

	d := &Daemon{
		Registry:   reg,
		Sampler:    sampler,
		socketPath: paths.TUISocketPath(),
		pid:        os.Getpid(),
	}
	return d, nil
}

// Serve binds the unix socket and accepts connections until ctx is
// cancelled or the listener errors fatally.
func (d *Daemon) Serve(ctx context.Context) error {
	if err := os.MkdirAll(paths.TUIStateDir(), 0o755); err != nil {
		return fmt.Errorf("mkdir state dir: %w", err)
	}
	// Stale socket from a previous run blocks Listen. Removing is safe
	// because the pm2 single-instance guarantee + the pid-file check
	// in main() catches the real "another daemon is running" case.
	_ = os.Remove(d.socketPath)

	l, err := net.Listen("unix", d.socketPath)
	if err != nil {
		return fmt.Errorf("listen %s: %w", d.socketPath, err)
	}
	// Restrict to the owning user — loopback semantics, single-owner.
	_ = os.Chmod(d.socketPath, 0o600)
	d.listener = l

	// Write our pid so the next launch can detect a stale socket vs a
	// live daemon. Best-effort; we don't fail if we can't write it.
	_ = os.WriteFile(paths.TUIDaemonPID(),
		[]byte(fmt.Sprintf("%d\n", d.pid)), 0o644)

	// Close listener on ctx cancel so Accept returns.
	go func() {
		<-ctx.Done()
		d.mu.Lock()
		d.closing = true
		d.mu.Unlock()
		_ = l.Close()
	}()

	for {
		conn, err := l.Accept()
		if err != nil {
			d.mu.Lock()
			closing := d.closing
			d.mu.Unlock()
			if closing {
				return nil
			}
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			// Transient accept errors — log and continue.
			fmt.Fprintln(os.Stderr, "yha-tui-daemon: accept:", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go d.handleConn(conn)
	}
}

// SocketPath returns the unix socket path the daemon is bound to.
func (d *Daemon) SocketPath() string { return d.socketPath }

// Close shuts the daemon down — closes the listener, stops the
// sampler, removes the socket file.
func (d *Daemon) Close() error {
	d.Sampler.Stop()
	if d.listener != nil {
		_ = d.listener.Close()
	}
	_ = os.Remove(d.socketPath)
	_ = os.Remove(paths.TUIDaemonPID())
	return nil
}

// ── per-connection handling ──────────────────────────────────────────────

type connState struct {
	conn      net.Conn
	out       chan Envelope
	subs      map[string]chan []byte // jobID → live-chunk channel
	listener  chan Envelope          // broadcast events
	daemon    *Daemon
	closeOnce sync.Once
	closed    chan struct{}
}

func (d *Daemon) handleConn(conn net.Conn) {
	cs := &connState{
		conn:     conn,
		out:      make(chan Envelope, 64),
		subs:     make(map[string]chan []byte),
		listener: make(chan Envelope, 32),
		daemon:   d,
		closed:   make(chan struct{}),
	}
	d.Registry.AddListener(cs.listener)

	defer func() {
		d.Registry.RemoveListener(cs.listener)
		cs.close()
	}()

	go cs.writer()
	go cs.broadcastPump()

	br := bufio.NewReader(conn)
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			return
		}
		var env Envelope
		if err := json.Unmarshal(bytesTrim(line), &env); err != nil {
			cs.send(Envelope{Op: OpError, Err: "bad json: " + err.Error(), Code: "bad-json"})
			continue
		}
		cs.dispatch(env)
	}
}

func (cs *connState) close() {
	cs.closeOnce.Do(func() {
		close(cs.closed)
		_ = cs.conn.Close()
		// Unsubscribe from all active jobs so the registry can GC.
		for jobID, ch := range cs.subs {
			cs.daemon.Registry.Unsubscribe(jobID, ch)
		}
	})
}

func (cs *connState) writer() {
	enc := bufio.NewWriter(cs.conn)
	for {
		select {
		case env, ok := <-cs.out:
			if !ok {
				return
			}
			line, err := env.MarshalLine()
			if err != nil {
				continue
			}
			if _, err := enc.Write(line); err != nil {
				cs.close()
				return
			}
			if err := enc.Flush(); err != nil {
				cs.close()
				return
			}
		case <-cs.closed:
			return
		}
	}
}

// broadcastPump forwards registry-wide events to this connection's
// writer queue. Drops on full channel rather than blocking the
// registry's listener fan-out.
func (cs *connState) broadcastPump() {
	for {
		select {
		case env, ok := <-cs.listener:
			if !ok {
				return
			}
			cs.send(env)
		case <-cs.closed:
			return
		}
	}
}

func (cs *connState) send(env Envelope) {
	select {
	case cs.out <- env:
	case <-cs.closed:
	default:
		// Writer queue is full — drop the slowest event class first.
		// For v1 just drop silently; logging a chunk per drop floods.
	}
}

func (cs *connState) dispatch(env Envelope) {
	switch env.Op {
	case OpPing:
		cs.send(Envelope{Op: OpPong, ID: env.ID})
	case OpStatus:
		snap := cs.daemon.Sampler.Get(len(cs.daemon.Registry.List()), cs.daemon.pid)
		cs.send(Envelope{Op: OpStatusSnap, ID: env.ID, Status: &snap})
	case OpListJobs:
		jobs := cs.daemon.Registry.List()
		cs.send(Envelope{Op: OpJobsList, ID: env.ID, Jobs: jobs})
	case OpCmd:
		cs.handleCmd(env)
	case OpSubscribeJob:
		cs.handleSubscribe(env)
	case OpUnsubscribeJob:
		cs.handleUnsubscribe(env)
	default:
		cs.send(Envelope{Op: OpError, ID: env.ID,
			Err:  "unknown op: " + env.Op,
			Code: "bad-op",
		})
	}
}

func (cs *connState) handleCmd(env Envelope) {
	if env.Cmd == "" {
		cs.send(Envelope{Op: OpError, ID: env.ID, Err: "cmd required", Code: "bad-cmd"})
		return
	}
	spec, err := BuildSpawn(env.Cmd, env.Args, env.Origin)
	if err != nil {
		cs.send(Envelope{Op: OpError, ID: env.ID, Err: err.Error(), Code: "bad-cmd"})
		return
	}
	job, err := cs.daemon.Registry.Spawn(spec)
	if err != nil {
		cs.send(Envelope{Op: OpError, ID: env.ID, Err: err.Error(), Code: "spawn-failed"})
		return
	}
	// Ack with the new job_id so the caller can subscribe.
	cs.send(Envelope{Op: OpAck, ID: env.ID, JobID: job.Info.JobID,
		Job: snapshotInfo(&job.Info)})
}

func (cs *connState) handleSubscribe(env Envelope) {
	if env.JobID == "" {
		cs.send(Envelope{Op: OpError, ID: env.ID, Err: "job_id required", Code: "bad-sub"})
		return
	}
	if _, already := cs.subs[env.JobID]; already {
		cs.send(Envelope{Op: OpAck, ID: env.ID, JobID: env.JobID, Err: "already subscribed"})
		return
	}
	ch := make(chan []byte, 16)
	file, _, err := cs.daemon.Registry.Subscribe(env.JobID, env.Since, ch)
	if err != nil {
		cs.send(Envelope{Op: OpError, ID: env.ID, Err: err.Error(), Code: "no-such-job"})
		return
	}
	cs.subs[env.JobID] = ch
	cs.send(Envelope{Op: OpAck, ID: env.ID, JobID: env.JobID})

	// Replay from disk, then live-tail via channel.
	go cs.streamJob(env.JobID, env.Since, file, ch)
}

func (cs *connState) handleUnsubscribe(env Envelope) {
	if ch, ok := cs.subs[env.JobID]; ok {
		cs.daemon.Registry.Unsubscribe(env.JobID, ch)
		delete(cs.subs, env.JobID)
	}
	cs.send(Envelope{Op: OpAck, ID: env.ID, JobID: env.JobID})
}

func (cs *connState) streamJob(jobID string, startOffset int64, file *os.File, ch chan []byte) {
	defer file.Close()

	// Phase 1: replay on-disk bytes up to current EOF.
	offset := startOffset
	buf := make([]byte, 8192)
	for {
		n, err := file.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			offset += int64(n)
			cs.send(Envelope{
				Op:         OpLogChunk,
				JobID:      jobID,
				Data:       string(chunk),
				NextOffset: offset,
			})
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return
		}
	}

	// Phase 2: live tail via subscriber channel (already attached by
	// Subscribe()). If Subscribe closed the channel up front (job
	// already ended), this loop exits immediately.
	for {
		select {
		case chunk, ok := <-ch:
			if !ok {
				return
			}
			offset += int64(len(chunk))
			cs.send(Envelope{
				Op:         OpLogChunk,
				JobID:      jobID,
				Data:       string(chunk),
				NextOffset: offset,
			})
		case <-cs.closed:
			return
		}
	}
}

func bytesTrim(b []byte) []byte {
	// Trim trailing \r\n / \n without allocating.
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}
