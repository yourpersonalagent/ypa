// harness.go — adapter that wires the existing Streamer into the
// generic harness.Harness interface defined in
// go-core/internal/harness/harness.go.
//
// The Streamer + processStream pair (claudebinary.go + events.go)
// already speaks the upstream binary's protocol. This file is the
// thin shim that:
//
//   - implements harness.Harness.ID() = "claude-binary"
//   - translates harness.Request → claudebinary.Request (SpawnOpts)
//   - bridges the Streamer's resolver to the framework-level History
//     so session-resume survives process restarts
//   - folds the post-stream FinalizePayload into a harness.Result
//     so the route handler can build a CostEventPayload
//
// Construction (cmd/yha-core/main.go boot):
//
//	hist, _ := harness.NewHistoryInDir(paths.BridgeRoot())
//	cbHarness := claudebinary.NewHarness(claudebinary.HarnessOpts{
//	    History: hist,
//	    Bin:     config.defaults.claudeBin,
//	    Logger:  log,
//	    Active:  ap,
//	})
//	registry.Register(cbHarness)
package claudebinary

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
// active-process map, and log fields. Public so tests + the Wave 3
// migrator can reference it without retyping the string.
const HarnessID = "claude-binary"

// errStreamerUnconfigured is returned when Stream is called on a nil
// Harness or one constructed without an underlying Streamer.
var errStreamerUnconfigured = errors.New("claudebinary.Harness: streamer unconfigured")

// HarnessOpts configures NewHarness. All fields are optional except
// History (which gives the adapter its session-resume store);
// missing fields fall back to sane defaults.
type HarnessOpts struct {
	// History is the cross-process session-resume index. The adapter
	// reads it before --resume and writes it after the first result
	// event. nil = in-memory-only fallback (sessions don't survive
	// daemon restart).
	History *harness.History

	// Bin is the default claude executable path. Empty = "claude"
	// via PATH. Tests inject a fake script here.
	Bin string

	// Logger is the daemon's structured logger. nil → discard.
	Logger *logger.Logger

	// Active is the ActiveProcesses registry — when set, every spawn
	// registers its kill func so a future POST /v1/sessions/:id/stop
	// can find it. nil = unsupported (Phase 6 scaffold leaves the
	// endpoint absent).
	Active *harness.ActiveProcesses

	// StreamerHooks are advanced overrides for testing — fake spawn
	// fn, finalize-watchdog timeout, custom resolver. Production
	// leaves it zero.
	StreamerHooks StreamerHooks
}

// StreamerHooks exposes the test seams the existing Streamer
// already supports (WithProcessSpawn, WithFinalizeKillTimeout). The
// adapter forwards these to the underlying Streamer at construction.
type StreamerHooks struct {
	ProcessSpawn        ProcessSpawnFn
	FinalizeKillTimeout time.Duration
}

// Harness implements harness.Harness around the existing Streamer.
type Harness struct {
	streamer *Streamer
	history  *harness.History
	active   *harness.ActiveProcesses
	defaults SpawnOpts
	log      *logger.Logger
}

// NewHarness returns a Harness ready to register with the framework.
func NewHarness(opts HarnessOpts) *Harness {
	log := opts.Logger
	if log == nil {
		log = logger.New(discardWriter{})
	}
	resolver := newHistoryResolver(opts.History)
	st := NewStreamer(resolver, log)
	if opts.StreamerHooks.ProcessSpawn != nil {
		st = st.WithProcessSpawn(opts.StreamerHooks.ProcessSpawn)
	}
	if d := opts.StreamerHooks.FinalizeKillTimeout; d > 0 {
		st = st.WithFinalizeKillTimeout(d)
	}
	return &Harness{
		streamer: st,
		history:  opts.History,
		active:   opts.Active,
		log:      log.With("harness", HarnessID),
		defaults: SpawnOpts{
			ClaudeBin: opts.Bin,
		},
	}
}

// ID implements harness.Harness.
func (h *Harness) ID() string { return HarnessID }

// Stream implements harness.Harness. Translates the framework's
// Request into a claudebinary.Request, drives the underlying
// Streamer, and folds the finalize payload into a harness.Result so
// the route handler can build its CostEventPayload.
//
// Concurrency: each call spawns its own subprocess + parser
// goroutine. The Streamer is safe for concurrent calls — its only
// shared state (the resolver) is mutex-guarded inside History.
func (h *Harness) Stream(ctx context.Context, req harness.Request, emit harness.Emit) (harness.Result, error) {
	if h == nil || h.streamer == nil {
		return harness.Result{}, errStreamerUnconfigured
	}

	// Translate FE skills → claudebinary skills (rename + flatten).
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
		blk := BuildImageBlock(b)
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
	spawn.AllowedTools = req.AllowedTools
	// Default to skip-permissions (yolo) — mirrors the TS
	// claude-stream default. If the caller wants explicit
	// allowedTools enforcement they can set AllowedTools and we'd
	// flip SkipPermissions=false via Caps; for the scaffold we keep
	// the simple default since reach-through caps surface isn't
	// wired yet.
	spawn.SkipPermissions = true
	spawn.WorkingDirConstraint = req.CWD != ""
	spawn.Stream = true
	spawn.HasImages = len(imageBlocks) > 0
	if v, ok := req.Caps["reasoning"].(string); ok {
		spawn.Reasoning = v
	}

	cbReq := Request{
		Prompt:           req.Input,
		HistorySessionID: req.HistorySessionID,
		Spawn:            spawn,
		ImageBlocks:      imageBlocks,
	}
	if cbReq.HistorySessionID == "" {
		cbReq.HistorySessionID = req.SessionID
	}

	// Wrap ctx so the ActiveProcesses kill switch can cancel this
	// call. The underlying Streamer doesn't expose a separate kill
	// closure — ctx cancellation IS the kill path (it propagates to
	// exec.CommandContext + the parser goroutine).
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
		// Emit an error chunk so the SSE consumer sees something
		// before close. Streamer already emits internal error
		// chunks for is_error=true; this catch is for spawn / parse
		// / cancellation failures that surface as a return error
		// without a chunk.
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

// discardWriter implements io.Writer for the no-logger fallback.
// Defined locally so we don't tie the harness adapter to the mcp
// package's helper.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
