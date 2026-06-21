//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package server

// BSD-family (incl. macOS) uses SO_REUSEPORT = 0x200.
const soReusePortValue = 0x200
