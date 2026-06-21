// harness.go — Harness implementation for the Hermes adapter.
//
// One per daemon; the route handler hands one harness.Request per turn
// and gets back a harness.Result + a stream of stream.Chunks via emit.
//
// Wired into main.go behind YHA_GO_HERMES=1 by the dedicated wiring
// agent — this file only provides the contract.

package hermes

import (
	"context"
	"errors"
	"strings"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/stream"
)

// HarnessID is the registry identifier. The framework's classifier
// picks this Harness when the FE's broadcast employee has
// partnerType="hermes".
const HarnessID = "hermes"

// Harness adapts the Hermes Gateway to the harness.Harness interface.
// Construct via New. The gateway is shared — every Stream call goes
// through the same singleton subprocess.
type Harness struct {
	gateway *Gateway
	mgr     *SessionManager
	log     Logger
}

// New builds a Harness pointing at the given Gateway. A fresh
// SessionManager is constructed so the Hermes session map is scoped
// to this harness. log may be nil (the gateway's logger is preferred,
// but this constructor lets the caller pass a more specific one).
func New(gw *Gateway, log *logger.Logger) *Harness {
	var l Logger
	if log != nil {
		l = log
	} else if gw != nil {
		l = gw.log
	} else {
		l = noopLogger{}
	}
	return &Harness{
		gateway: gw,
		mgr:     NewSessionManager(gw),
		log:     l,
	}
}

// ID implements harness.Harness.
func (h *Harness) ID() string { return HarnessID }

// Gateway exposes the underlying Gateway. Used by the control-plane
// route (status / restart endpoints) and by the wiring agent to share
// one instance across multiple consumers.
func (h *Harness) Gateway() *Gateway { return h.gateway }

// Sessions exposes the underlying SessionManager. Used by the
// /v1/partners/:id refresh route to drop / re-create sessions when a
// partner record changes.
func (h *Harness) Sessions() *SessionManager { return h.mgr }

// Stream drives one Hermes chat turn.
//
// Steps:
//  1. Resolve partnerID from req.BroadcastEmp.PartnerID (or .ID).
//  2. Build PromptOpts from req.Preset (system prompt) + req.Model
//     (preset apply) + req.ImageBlocks (attachments).
//  3. Call SubmitPrompt. onDelta forwards each delta as a
//     ChunkTypeDelta chunk via emit. The final assembled text is
//     wrapped in a ChunkTypeDone chunk.
//
// Errors: spawn / RPC / timeout failures return Result.Err with a
// matching stream.ChunkTypeError emitted to the caller. Idle / total
// timeout messages mirror the Node port verbatim.
func (h *Harness) Stream(ctx context.Context, req harness.Request, emit harness.Emit) (harness.Result, error) {
	if h.gateway == nil {
		err := errors.New("hermes: gateway not configured")
		return harness.Result{Err: err}, err
	}
	if emit == nil {
		err := errors.New("hermes: emit must be non-nil")
		return harness.Result{Err: err}, err
	}

	partnerID := resolvePartnerID(req)
	if partnerID == "" {
		err := errors.New("hermes: req.BroadcastEmp.PartnerID required")
		return harness.Result{Err: err}, err
	}
	if strings.TrimSpace(req.Input) == "" {
		err := errors.New("hermes: input required")
		return harness.Result{Err: err}, err
	}

	opts := PromptOpts{
		ImageBlocks: convertImageBlocks(req.ImageBlocks),
		Presets: Presets{
			Model:        req.Model,
			SystemPrompt: req.Preset,
		},
	}

	// Forward each delta to the route's emit closure. The closure runs
	// on a single goroutine (the SubmitPrompt event loop) so it
	// satisfies the harness.Emit "single emitter at a time" rule.
	onDelta := func(delta string) {
		if delta == "" {
			return
		}
		emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: delta})
	}

	res, err := SubmitPrompt(ctx, h.gateway, h.mgr, req.SessionID, partnerID, req.Input, onDelta, opts)
	if err != nil {
		// Surface an error chunk so the SSE consumer sees the failure
		// inline. Match the openclaw pattern.
		emit(stream.Chunk{Type: stream.ChunkTypeError, Error: err.Error()})
		return harness.Result{
			Text: res.RawText,
			Err:  err,
		}, err
	}

	// Final done chunk carries the image-processed text and the
	// provider tag so the route's SSE wire is identical to the Node
	// path (same client-visible shape).
	stopReason := res.Status
	if stopReason == "" {
		stopReason = "stop"
	}
	emit(stream.Chunk{
		Type:       stream.ChunkTypeDone,
		Text:       res.Text,
		DoneReason: stopReason,
		Provider:   "hermes",
	})

	return harness.Result{
		Text:       res.Text,
		StopReason: stopReason,
		Usage:      harness.Usage{Model: req.Model},
	}, nil
}

// resolvePartnerID picks the partner identifier from the request.
// Preference order:
//  1. req.BroadcastEmp.PartnerID (the explicit partner slot).
//  2. req.BroadcastEmp.ID (the FE employee id; partner records reuse
//     their own id as the partner slot when only one is wired).
//
// Returns "" when BroadcastEmp is nil — the caller surfaces this as
// a contract error.
func resolvePartnerID(req harness.Request) string {
	if req.BroadcastEmp == nil {
		return ""
	}
	if id := strings.TrimSpace(req.BroadcastEmp.PartnerID); id != "" {
		return id
	}
	return strings.TrimSpace(req.BroadcastEmp.ID)
}

func convertImageBlocks(in []harness.ImageBlock) []ImageBlock {
	if len(in) == 0 {
		return nil
	}
	out := make([]ImageBlock, 0, len(in))
	for _, b := range in {
		out = append(out, ImageBlock{
			MediaType: b.MediaType,
			Base64:    b.Base64,
		})
	}
	return out
}

// Compile-time assertion that *Harness satisfies the framework contract.
var _ harness.Harness = (*Harness)(nil)
