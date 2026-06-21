//go:build windows

package main

import "context"

// Windows has no SIGUSR2 and no SO_REUSEPORT blue-green reload. Return
// a context that will never be canceled by a signal — drainCtx.Done()
// is effectively dead code on Windows, which matches the feature being
// unavailable.
func notifyDrainSignal(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithCancel(parent)
}
