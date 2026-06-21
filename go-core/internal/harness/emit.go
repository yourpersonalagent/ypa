// AdaptEmit — buffer + SSE writer fusion.
//
// The route handler already owns the SSE writer (Response.Write +
// flusher) and the per-session reattach buffer (stream.SessionBuffer).
// Harness adapters don't care about either — they just emit
// stream.Chunks via the Emit closure they're handed. AdaptEmit is the
// adapter: it stamps Seq via Buffer.Append (so reattach sees the
// chunk) and then calls the supplied write closure to push it on the
// SSE wire.
//
// This keeps Buffer.Append as the single source of seq stamping. The
// adapter never sees seq numbers; the caller's write closure also
// doesn't need to — it operates on the already-stamped chunk.
//
// Concurrency: AdaptEmit returns an Emit closure that is NOT safe for
// concurrent callers. Adapters that fan out into goroutines must
// serialise themselves before calling emit (the existing
// claudebinary parser runs single-threaded, so this is fine today).
package harness

import (
	"github.com/yha/core/internal/stream"
)

// AdaptEmit wraps a SessionBuffer.Append + an SSE write closure into
// a single Emit the harness adapters can call uniformly. sessionID
// keys the buffer; when sessionID is empty (or buffer is nil) the
// buffer step is skipped and the chunk passes through unchanged.
//
// write is the actual SSE writer (the same closure route.go builds
// for direct-API). It is called with the stamped chunk so a later
// reattach reads the same Seq value the live stream saw.
//
// Tests build their own buffer + capturing write so the adapter sees
// a real Emit signature without spinning up an httptest.Server.
func AdaptEmit(buffer *stream.SessionBuffer, sessionID string, write func(stream.Chunk)) Emit {
	if write == nil {
		write = func(stream.Chunk) {}
	}
	return func(c stream.Chunk) {
		if buffer != nil && sessionID != "" {
			c = buffer.Append(sessionID, c)
		}
		write(c)
	}
}
