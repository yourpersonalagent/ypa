// harness.go — adapter that wires the Streamer into the framework's
// harness.Harness interface (go-core/internal/harness/harness.go).
//
// The Streamer + processStream pair (claudesdk.go + events.go) already
// speaks the binary's protocol. This file is the thin shim that:
//
//   - implements harness.Harness.ID() = "claude-sdk"
//   - translates harness.Request → claudesdk.Request (SpawnOpts)
//   - resolves per-call MCP opts from env + Request.SessionID
//   - folds the post-stream FinalizePayload into a harness.Result
//
// Construction (cmd/yha-core/main.go boot — handled by the wiring agent):
//
//	h := claudesdk.NewHarness(claudesdk.HarnessOpts{
//	    Bin:        config.defaults.claudeBin,
//	    BridgeURL:  fmt.Sprintf("http://127.0.0.1:%d", config.port),
//	    BridgeKey:  config.bridgeInternalKey,
//	    Logger:     log,
//	    Active:     ap,
//	})
//	registry.Register(h)
package claudesdk

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/stream"
)

// HarnessID is the canonical id used in the registry, history file,
// active-process map, and log fields. The route-harness env-flag
// helper uppercases this to "CLAUDE_SDK" and appends to "YHA_GO_" —
// so the opt-in is YHA_GO_CLAUDE_SDK=1.
const HarnessID = "claude-sdk"

// errStreamerUnconfigured is returned when Stream is called on a nil
// Harness or one constructed without an underlying Streamer.
var errStreamerUnconfigured = errors.New("claudesdk.Harness: streamer unconfigured")

// HarnessOpts configures NewHarness. All fields are optional;
// missing fields fall back to sane defaults.
type HarnessOpts struct {
	// Bin is the default claude executable path. Empty = "claude"
	// via PATH. Tests inject a fake script here.
	Bin string

	// BridgeURL is the http://127.0.0.1:<port> URL the MCP stub
	// forwards JSON-RPC frames to. Required for MCP wiring; without it
	// every spawn runs without MCP servers (and emits a Warn).
	BridgeURL string

	// BridgeKey is the BRIDGE_INTERNAL_KEY value used as
	// ANTHROPIC_API_KEY when the binary is proxy-routed (External
	// model). Empty falls through to the host env's value.
	BridgeKey string

	// Logger is the daemon's structured logger. nil → discard.
	Logger *logger.Logger

	// Active is the ActiveProcesses registry — when set, every spawn
	// registers its kill func so a future POST /v1/sessions/:id/stop
	// can find it. nil = unsupported.
	Active *harness.ActiveProcesses

	// StreamerHooks are advanced overrides for testing — fake spawn
	// fn, finalize-watchdog timeout. Production leaves it zero.
	StreamerHooks StreamerHooks
}

// StreamerHooks exposes the test seams the underlying Streamer
// already supports (WithProcessSpawn, WithFinalizeKillTimeout).
type StreamerHooks struct {
	ProcessSpawn        ProcessSpawnFn
	FinalizeKillTimeout time.Duration
}

// Harness implements harness.Harness around the Streamer.
type Harness struct {
	streamer  *Streamer
	active    *harness.ActiveProcesses
	defaults  SpawnOpts
	bridgeURL string
	bridgeKey string
	log       *logger.Logger
}

// NewHarness returns a Harness ready to register with the framework.
func NewHarness(opts HarnessOpts) *Harness {
	log := opts.Logger
	if log == nil {
		log = logger.New(discardWriter{})
	}
	st := NewStreamer(log)
	if opts.StreamerHooks.ProcessSpawn != nil {
		st = st.WithProcessSpawn(opts.StreamerHooks.ProcessSpawn)
	}
	if d := opts.StreamerHooks.FinalizeKillTimeout; d > 0 {
		st = st.WithFinalizeKillTimeout(d)
	}
	return &Harness{
		streamer:  st,
		active:    opts.Active,
		bridgeURL: opts.BridgeURL,
		bridgeKey: opts.BridgeKey,
		log:       log.With("harness", HarnessID),
		defaults: SpawnOpts{
			ClaudeBin: opts.Bin,
		},
	}
}

// ID implements harness.Harness.
func (h *Harness) ID() string { return HarnessID }

// Stream implements harness.Harness. Translates the framework's
// Request into a claudesdk.Request, drives the Streamer, and folds
// the finalize payload into a harness.Result.
//
// Concurrency: each call spawns its own subprocess + parser goroutine.
// The Streamer is safe for concurrent calls (it has no per-request
// mutable state beyond the spawn returns).
func (h *Harness) Stream(ctx context.Context, req harness.Request, emit harness.Emit) (harness.Result, error) {
	if h == nil || h.streamer == nil {
		return harness.Result{Err: errStreamerUnconfigured}, errStreamerUnconfigured
	}
	if emit == nil {
		err := errors.New("claudesdk.Stream: emit must be non-nil")
		return harness.Result{Err: err}, err
	}

	// Translate FE skills → claudesdk skills.
	skills := make([]Skill, 0, len(req.Skills))
	for _, s := range req.Skills {
		if strings.TrimSpace(s.Name) == "" && strings.TrimSpace(s.Content) == "" {
			continue
		}
		skills = append(skills, Skill{Name: s.Name, Content: s.Content})
	}

	// Translate FE image blocks → upstream multi-block wire shape.
	imageBlocks := make([]map[string]any, 0, len(req.ImageBlocks))
	for _, b := range req.ImageBlocks {
		blk := buildImageBlock(b)
		if blk != nil {
			imageBlocks = append(imageBlocks, blk)
		}
	}

	spawn := h.defaults
	spawn.CWD = req.CWD
	spawn.Model = req.Model
	spawn.Effort = req.Effort
	spawn.Preset = req.Preset
	spawn.SysMode = req.SystemMode
	spawn.Skills = skills
	spawn.WorkingDirConstraint = req.CWD != ""
	if v, ok := req.Caps["reasoning"].(string); ok {
		spawn.Reasoning = v
	}
	// BridgeKey is the default for External flows; the caller can still
	// override per-request via the Caps map if they need to swap keys.
	spawn.BridgeKey = h.bridgeKey

	cbReq := Request{
		Prompt:           req.Input,
		HistorySessionID: req.HistorySessionID,
		Spawn:            spawn,
		ImageBlocks:      imageBlocks,
		MCP: MCPConfigOpts{
			SessionID: req.SessionID,
			BridgeURL: h.bridgeURL,
		},
	}
	if cbReq.HistorySessionID == "" {
		cbReq.HistorySessionID = req.SessionID
	}

	// Wire ActiveProcesses for the stop endpoint.
	if h.active != nil && req.SessionID != "" {
		cancelCtx, cancel := context.WithCancel(ctx)
		ctx = cancelCtx
		h.active.Register(req.SessionID, func() { cancel() })
		defer h.active.Drop(req.SessionID)
	}

	// harness.Emit and stream.EmitFn share the same underlying type
	// (func(stream.Chunk)) — direct conversion is safe.
	wrapped := stream.EmitFn(emit)

	fin, err := h.streamer.Stream(ctx, cbReq, wrapped)
	if err != nil {
		emit(stream.Chunk{Type: stream.ChunkTypeError, Error: err.Error()})
		return harness.Result{Err: err}, err
	}

	res := harness.Result{
		Text:       fin.Text,
		StopReason: fin.StopReason,
		Usage: harness.Usage{
			InputTokens:   int64(fin.InputTokens),
			OutputTokens:  int64(fin.OutputTokens),
			CacheRead:     int64(fin.CacheReadTokens),
			CacheCreation: int64(fin.CacheCreationTokens),
			Cost:          fin.Cost,
			Model:         req.Model,
		},
	}
	return res, nil
}

// buildImageBlock renders a single ImageBlock into the wire shape.
// Returns nil for empty / invalid input so the caller can filter
// without explicit error handling. MediaType defaults to "image/png"
// when unset. (Attribution: mirrors claudebinary/image.go's
// buildImageBlock — duplicated locally to avoid an import dependency
// on the binary harness package.)
func buildImageBlock(in harness.ImageBlock) map[string]any {
	data := strings.TrimSpace(in.Base64)
	if data == "" {
		return nil
	}
	mediaType := strings.TrimSpace(in.MediaType)
	if mediaType == "" {
		mediaType = "image/png"
	}
	return map[string]any{
		"type": "image",
		"source": map[string]any{
			"type":       "base64",
			"media_type": mediaType,
			"data":       data,
		},
	}
}

// discardWriter implements io.Writer for the no-logger fallback.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
