//go:build !windows

package main

import (
	"context"
	"os/signal"
	"syscall"
)

func notifyDrainSignal(parent context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, syscall.SIGUSR2)
}
