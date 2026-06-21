//go:build windows

package server

import "net"

// Windows has no real SO_REUSEPORT — its SO_REUSEADDR allows multiple
// binds but with last-bind-wins semantics, not the load-balancing
// Linux/macOS provide. The blue-green reload pattern (./yha.sh
// go-reload) is therefore not supported here. We fall back to a plain
// listener; "reload" on Windows means stop + restart.
func listenReusePort(network, addr string) (net.Listener, error) {
	return net.Listen(network, addr)
}
