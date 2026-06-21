//go:build !windows

package server

import (
	"context"
	"fmt"
	"net"
	"syscall"
)

// soReusePortValue is the SO_REUSEPORT socket option number. Go's
// stdlib syscall package only exposes the constant on a subset of
// arches — notably linux/arm64 has it but linux/amd64 dropped it as of
// Go 1.26 (moved to golang.org/x/sys/unix). The kernel ABI value is
// stable per-OS, so we pin it locally rather than pulling in x/sys.
// See reuseport_linux.go / reuseport_darwin.go / reuseport_bsd.go for
// the per-OS constant — split that way because the value differs.

// listenReusePort binds a TCP listener with SO_REUSEADDR + SO_REUSEPORT
// set on the underlying socket. With both flags two processes on the
// same host can hold the same port at the same time; the kernel
// load-balances new connections between them. This is the foundation
// of the blue-green restart in `./yha.sh go-reload`.
func listenReusePort(network, addr string) (net.Listener, error) {
	lc := net.ListenConfig{
		Control: func(_, _ string, c syscall.RawConn) error {
			var setErr error
			err := c.Control(func(fd uintptr) {
				if e := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); e != nil {
					setErr = fmt.Errorf("set SO_REUSEADDR: %w", e)
					return
				}
				if e := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, soReusePortValue, 1); e != nil {
					setErr = fmt.Errorf("set SO_REUSEPORT: %w", e)
					return
				}
			})
			if err != nil {
				return err
			}
			return setErr
		},
	}
	return lc.Listen(context.Background(), network, addr)
}
