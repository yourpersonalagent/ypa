// harness.go — Harness implementation for the OpenClaw adapter.
//
// One per daemon; the route handler hands one harness.Request per turn
// and gets back a harness.Result + a stream of stream.Chunks via emit.

package openclaw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/stream"
)

// HarnessID is the registry identifier. The framework's classifier picks
// this Harness when the FE's broadcast employee has partnerType="openclaw".
const HarnessID = "openclaw"

// SessionResolver mirrors the scaffold's harness.History interface in a
// minimal form — Get/Set keyed by harnessID + composite-yha-sid. We
// scope it to this package so the OpenClaw harness can land before the
// shared harness.History type is finalised. Production wires the
// scaffold's History via a small adapter (see Register below).
//
// The composite key shape is "<yhaSessionID>::<partnerID>" — multiple
// partner records share one YHA session id but each one has its own
// OpenClaw sessionKey. The harness composes the key before calling
// Get/Set, so callers can pass a plain harnessID-keyed History.
type SessionResolver interface {
	Get(harnessID, key string) string
	Set(harnessID, key, value string)
}

// MemoryResolver is the default in-process implementation, suitable for
// the Phase 6 single-daemon deployment. Phase 7 (multi-daemon) replaces
// this with the JSON-backed harness.History scaffold provides.
type MemoryResolver struct {
	mu sync.RWMutex
	m  map[string]string // "harnessID|key" → value
}

// NewMemoryResolver builds an empty resolver.
func NewMemoryResolver() *MemoryResolver { return &MemoryResolver{m: map[string]string{}} }

// Get implements SessionResolver.
func (r *MemoryResolver) Get(harnessID, key string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.m[harnessID+"|"+key]
}

// Set implements SessionResolver.
func (r *MemoryResolver) Set(harnessID, key, value string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.m[harnessID+"|"+key] = value
}

// Harness is the OpenClaw adapter. Construct with NewHarness.
type Harness struct {
	pool     *Pool
	resolver SessionResolver
	log      Logger

	// Configurable timeouts — exposed for tests.
	idleTimeout  time.Duration
	totalTimeout time.Duration
}

// NewHarness wires a pool + resolver into a Harness. resolver may be
// nil — we fall back to MemoryResolver.
func NewHarness(pool *Pool, resolver SessionResolver, log Logger) *Harness {
	if resolver == nil {
		resolver = NewMemoryResolver()
	}
	if log == nil {
		log = noopLogger{}
	}
	return &Harness{
		pool:         pool,
		resolver:     resolver,
		log:          log,
		idleTimeout:  DefaultIdleTimeout,
		totalTimeout: DefaultTotalTimeout,
	}
}

// WithTimeouts returns a copy with overridden idle/total budgets. Used
// by tests; production keeps the defaults.
func (h *Harness) WithTimeouts(idle, total time.Duration) *Harness {
	cp := *h
	if idle > 0 {
		cp.idleTimeout = idle
	}
	if total > 0 {
		cp.totalTimeout = total
	}
	return &cp
}

// ID implements harness.Harness.
func (h *Harness) ID() string { return HarnessID }

// Stream drives one turn of an OpenClaw conversation.
//
// Steps:
//  1. Resolve partnerID from req.BroadcastEmp.PartnerID.
//  2. pool.Get(partnerID) → client; Connect if not already.
//  3. Compose composite key "<yhaSID>::<partnerID>" → look up existing
//     OpenClaw sessionKey via resolver.Get(HarnessID, composite).
//  4. If no sessionKey: client.Send("sessions.create", {agentId}).
//     Store the new key in the resolver under the composite key.
//  5. Image attachments (each ImageBlock): client.Send("image.attach",
//     {sessionKey, mediaType, base64}). (TS doesn't ship this yet; we
//     stub the call but ignore "unknown method" errors so old gateways
//     still work.)
//  6. Subscribe(sessionKey, emit) — translates server-push events.
//  7. client.Send("chat.send", {sessionKey, text}) — fire-and-forget
//     (the response is the synchronous ack; the actual content comes
//     via session.message events).
//  8. Wait for session.message{final:true} → return Result with usage.
//     Or session.error → return Result.Err. Or ctx.Done → send
//     chat.cancel and return ctx.Err.
//
// emit is called from the WS read loop. The harness wraps it so only
// the harness goroutine sees the chunk before forwarding — keeps the
// "single emitter at a time" invariant the framework relies on.
func (h *Harness) Stream(ctx context.Context, req harness.Request, emit harness.Emit) (harness.Result, error) {
	if req.BroadcastEmp == nil || req.BroadcastEmp.PartnerID == "" {
		return harness.Result{}, errors.New("openclaw: req.BroadcastEmp.PartnerID required")
	}
	partnerID := req.BroadcastEmp.PartnerID

	client, err := h.pool.Get(partnerID)
	if err != nil {
		return harness.Result{}, err
	}

	connCtx, cancelConn := context.WithTimeout(ctx, HandshakeTimeout+5*time.Second)
	if err := client.Connect(connCtx); err != nil {
		cancelConn()
		return harness.Result{}, fmt.Errorf("openclaw: connect: %w", err)
	}
	cancelConn()

	composite := req.SessionID + "::" + partnerID
	sessionKey := h.resolver.Get(HarnessID, composite)

	if sessionKey == "" {
		createParams := map[string]any{"agentId": client.AgentID()}
		payload, err := client.SendWithTimeout(ctx, "sessions.create", createParams, CreateSessionTimeout)
		if err != nil {
			return harness.Result{}, fmt.Errorf("openclaw: sessions.create: %w", err)
		}
		var resp struct {
			SessionKey string `json:"sessionKey"`
		}
		if err := json.Unmarshal(payload, &resp); err != nil {
			return harness.Result{}, fmt.Errorf("openclaw: sessions.create decode: %w", err)
		}
		if resp.SessionKey == "" {
			return harness.Result{}, errors.New("openclaw: sessions.create returned no sessionKey")
		}
		sessionKey = resp.SessionKey
		h.resolver.Set(HarnessID, composite, sessionKey)
		h.log.Info("openclaw.session-created",
			"yhaSession", req.SessionID,
			"partnerId", partnerID,
			"sessionKey", sessionKey,
			"agentId", client.AgentID())
	}

	// Image attachments. Mirror the TS code pattern: send each via
	// "image.attach". The TS port doesn't have this wired yet so we
	// soft-fail on unknown-method errors so older gateways aren't
	// rejected.
	for _, img := range req.ImageBlocks {
		params := map[string]any{
			"sessionKey": sessionKey,
			"mediaType":  img.MediaType,
			"base64":     img.Base64,
		}
		if _, err := client.Send(ctx, "image.attach", params); err != nil {
			if !isUnknownMethod(err) {
				return harness.Result{}, fmt.Errorf("openclaw: image.attach: %w", err)
			}
			h.log.Warn("openclaw.image-attach-unsupported", "err", err)
		}
	}

	// Subscribe before send so we don't miss early deltas.
	turnDone := make(chan harness.Result, 1)
	var (
		accum    strings.Builder
		idleArm  *time.Timer
		idleMu   sync.Mutex
		idleFire = func() {
			idleMu.Lock()
			defer idleMu.Unlock()
			if idleArm != nil {
				idleArm.Stop()
			}
			idleArm = time.AfterFunc(h.idleTimeout, func() {
				turnDone <- harness.Result{
					Text: accum.String(),
					Err:  fmt.Errorf("openclaw: idle timeout after %s", h.idleTimeout),
				}
			})
		}
	)
	idleFire()

	defer func() {
		idleMu.Lock()
		if idleArm != nil {
			idleArm.Stop()
		}
		idleMu.Unlock()
		client.Unsubscribe(sessionKey)
	}()

	emitChunk := func(c stream.Chunk) {
		// Drop the upstream done — we synthesise our own at the end so
		// the route gets one cleanly typed terminal chunk.
		if c.Type == stream.ChunkTypeDone {
			// Treat as turn-final: store accumulated text + usage we
			// don't carry yet (gateways aren't surfacing usage in
			// session.message events today).
			text := c.Text
			if text == "" {
				text = accum.String()
			}
			turnDone <- harness.Result{
				Text:       text,
				StopReason: c.DoneReason,
			}
			return
		}
		if c.Type == stream.ChunkTypeError {
			turnDone <- harness.Result{
				Text: accum.String(),
				Err:  errors.New(c.Error),
			}
			return
		}
		if c.Type == stream.ChunkTypeDelta && c.Delta != "" {
			accum.WriteString(c.Delta)
			idleFire()
		}
		// Forward everything to the route's emit.
		emit(c)
	}
	client.Subscribe(sessionKey, emitChunk)

	// Fire the chat.send. The response carries no payload of interest
	// (the actual content streams via session.message events) but we
	// still want to surface synchronous errors here.
	chatParams := map[string]any{
		"sessionKey": sessionKey,
		"text":       req.Input,
	}
	if _, err := client.Send(ctx, "chat.send", chatParams); err != nil {
		client.Unsubscribe(sessionKey)
		return harness.Result{}, fmt.Errorf("openclaw: chat.send: %w", err)
	}

	// Wait. The first of: turn-final event, ctx cancellation, or total
	// timeout wins.
	totalT := time.NewTimer(h.totalTimeout)
	defer totalT.Stop()

	select {
	case res := <-turnDone:
		if res.Err != nil {
			return res, res.Err
		}
		// Synthesise final done chunk for the route's SSE wire (the
		// fanout above already emitted upstream).
		emit(stream.Chunk{
			Type:       stream.ChunkTypeDone,
			Text:       res.Text,
			DoneReason: ifEmpty(res.StopReason, "stop"),
			Provider:   "openclaw",
		})
		return harness.Result{
			Text:       res.Text,
			StopReason: ifEmpty(res.StopReason, "stop"),
			Usage:      harness.Usage{Model: req.Model},
		}, nil
	case <-ctx.Done():
		// Best-effort cancellation: tell the gateway to stop and
		// return ctx.Err.
		cancelParams := map[string]any{"sessionKey": sessionKey}
		cancelCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if _, err := client.Send(cancelCtx, "chat.cancel", cancelParams); err != nil {
			// Best-effort — chat.cancel may not exist on older gateways.
			h.log.Warn("openclaw.chat-cancel-failed", "err", err)
		}
		cancel()
		return harness.Result{Text: accum.String(), Err: ctx.Err()}, ctx.Err()
	case <-totalT.C:
		// Total-timeout. Drop the session — TS does this on error and
		// session.error paths (openclaw.ts:325).
		return harness.Result{
			Text: accum.String(),
			Err:  fmt.Errorf("openclaw: total timeout after %s", h.totalTimeout),
		}, fmt.Errorf("openclaw: total timeout after %s", h.totalTimeout)
	}
}

// Compile-time assertion that *Harness satisfies the framework interface.
var _ harness.Harness = (*Harness)(nil)

// ── helpers ────────────────────────────────────────────────────────────────

func isUnknownMethod(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "unknown method") ||
		strings.Contains(s, "method not found") ||
		strings.Contains(s, "no such method")
}

func ifEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
