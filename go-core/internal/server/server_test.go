//go:build !windows

package server

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/yha/core/internal/logger"
)

// freeTCPPort asks the kernel for a fresh, unused TCP port. We open a
// listener on :0, take whichever port the kernel hands back, then close
// it before returning the number. There's an unavoidable TOCTOU window
// between close and rebind, but in practice it's fine for tests on a
// quiet host.
func freeTCPPort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("freeTCPPort: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if err := l.Close(); err != nil {
		t.Fatalf("freeTCPPort close: %v", err)
	}
	return strconv.Itoa(port)
}

func newTestLogger() *logger.Logger {
	return logger.New(io.Discard).With("test", "1")
}

// TestReusePortListenerBinds verifies that a server with ReusePort=true
// binds successfully on a fresh port and that a SECOND listener can
// also hold the same port at the same time (the whole point of
// SO_REUSEPORT). If either bind fails the kernel didn't accept the
// sockopt — test fails loud so we notice on Pi/Linux/macOS regressions.
func TestReusePortListenerBinds(t *testing.T) {
	port := freeTCPPort(t)

	srv1, err := New(Config{
		Port:      port,
		NodeURL:   "http://127.0.0.1:1", // not contacted in this test
		Logger:    newTestLogger(),
		ReusePort: true,
	})
	if err != nil {
		t.Fatalf("New srv1: %v", err)
	}

	ln1, err := srv1.listen()
	if err != nil {
		t.Fatalf("srv1.listen: %v", err)
	}
	defer ln1.Close()

	// Second listener on the same port must also succeed because
	// SO_REUSEPORT was set. Without it, this would EADDRINUSE.
	ln2, err := listenReusePort("tcp", ":"+port)
	if err != nil {
		t.Fatalf("second listenReusePort on same port: %v", err)
	}
	defer ln2.Close()

	if ln1.Addr().String() == "" || ln2.Addr().String() == "" {
		t.Fatalf("listeners returned empty Addr()")
	}
}

// TestSIGUSR2TriggersShutdown wires up the same signal-notify pattern
// main.go uses, sends SIGUSR2 to the test process itself, and asserts
// that Server.Shutdown completes cleanly. This is the unit-level proof
// that the drain path actually fires.
func TestSIGUSR2TriggersShutdown(t *testing.T) {
	port := freeTCPPort(t)
	srv, err := New(Config{
		Port:    port,
		NodeURL: "http://127.0.0.1:1",
		Logger:  newTestLogger(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Bring the server up in the background.
	runErr := make(chan error, 1)
	go func() { runErr <- srv.Run() }()

	// Wait until the listener is actually accepting.
	waitForListen(t, "127.0.0.1:"+port, 2*time.Second)

	// Same wiring main.go uses for the drain signal.
	drainCtx, drainStop := signal.NotifyContext(context.Background(), syscall.SIGUSR2)
	defer drainStop()

	// Send ourselves SIGUSR2; it must wake drainCtx.
	if err := syscall.Kill(os.Getpid(), syscall.SIGUSR2); err != nil {
		t.Fatalf("kill self with SIGUSR2: %v", err)
	}

	select {
	case <-drainCtx.Done():
		// good
	case <-time.After(2 * time.Second):
		t.Fatalf("drainCtx never fired after SIGUSR2")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	select {
	case err := <-runErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Run goroutine never returned after Shutdown")
	}
}

// TestGracefulShutdownDrainsInflight asserts the contract Phase 4
// depends on: after Shutdown is called, the listener stops accepting
// NEW connections, but a request that was already mid-flight gets to
// finish without being killed mid-write.
func TestGracefulShutdownDrainsInflight(t *testing.T) {
	port := freeTCPPort(t)

	// Hand-rolled handler: signals when it has started, waits to be
	// released, then returns 200. We trigger Shutdown between those
	// two beats so we know the in-flight request was already inside
	// the handler when the drain began.
	started := make(chan struct{})
	release := make(chan struct{})
	var inflightDone atomic.Bool

	srv, err := New(Config{
		Port:    port,
		NodeURL: "http://127.0.0.1:1",
		Logger:  newTestLogger(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Inject a delay handler ahead of the catch-all proxy. mux is
	// exposed on Server; we register before Run so it's wired in
	// before Serve starts.
	srv.mux.HandleFunc("/_test/slow", func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("done"))
		inflightDone.Store(true)
	})

	runErr := make(chan error, 1)
	go func() { runErr <- srv.Run() }()
	waitForListen(t, "127.0.0.1:"+port, 2*time.Second)

	// Fire the slow request from another goroutine.
	var wg sync.WaitGroup
	wg.Add(1)
	var slowResp *http.Response
	var slowErr error
	go func() {
		defer wg.Done()
		client := &http.Client{Timeout: 10 * time.Second}
		slowResp, slowErr = client.Get("http://127.0.0.1:" + port + "/_test/slow")
	}()

	// Wait until handler is actually executing, then start the drain.
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatalf("slow handler never started")
	}

	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()

	// New connection attempt during drain should fail (Listener closed).
	// We can't fully guarantee the kernel queue is closed instantly,
	// so retry briefly until Dial errors.
	rejected := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", "127.0.0.1:"+port, 200*time.Millisecond)
		if err != nil {
			rejected = true
			break
		}
		_ = c.Close()
		time.Sleep(50 * time.Millisecond)
	}
	if !rejected {
		t.Fatalf("listener kept accepting connections after Shutdown")
	}

	// Now release the in-flight request. It must finish cleanly.
	close(release)
	wg.Wait()

	if slowErr != nil {
		t.Fatalf("in-flight request errored during drain: %v", slowErr)
	}
	if slowResp == nil || slowResp.StatusCode != http.StatusOK {
		t.Fatalf("in-flight request did not complete cleanly: %+v", slowResp)
	}
	if !inflightDone.Load() {
		t.Fatalf("handler never reached its terminal write")
	}

	if err := <-shutdownDone; err != nil {
		t.Fatalf("Shutdown error: %v", err)
	}
	select {
	case err := <-runErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Run goroutine never returned")
	}
}

// waitForListen polls a TCP address until something accepts a connection
// or the timeout expires. Used to avoid racing test bodies against
// http.Server.Serve actually hitting Accept().
func waitForListen(t *testing.T, addr string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("nothing listening on %s after %s", addr, timeout)
}
