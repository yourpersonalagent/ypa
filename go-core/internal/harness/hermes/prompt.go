// prompt.go — single-turn chat driver for the Hermes gateway.
//
// SubmitPrompt is the core entry point: it resolves (or creates) a
// Hermes session, attaches images, fires prompt.submit, then drains
// per-session events until message.complete or an error. The dual
// watchdog (idle + total) mirrors hermes.ts:332-460 exactly — a single
// absolute timeout is too blunt for long Hermes tool chains.
//
// The "assembled text" the call returns has local markdown image
// references rewritten to base64 data URIs so the browser doesn't try
// to fetch local file paths it can't see. Helper _processHermesImages
// mirrors the same name in hermes.ts.
//
// Image attach: per attachment, we materialise a temp file inside
// os.TempDir() (capped at ImageAttachMaxBytes per file), call the
// image.attach RPC, and defer-unlink after the turn finishes. Names
// collide-safely via timestamp + crypto/rand suffix so concurrent
// turns don't stomp on each other.
//
// Prompt-request callbacks (approval/clarify/sudo/secret) are fed
// through PromptOpts.OnPromptRequest verbatim — the caller composes
// the appropriate response.

package hermes

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	// DefaultIdleTimeout matches hermes.ts:343 (5 min).
	DefaultIdleTimeout = 5 * time.Minute
	// DefaultTotalTimeout matches hermes.ts:344 (30 min).
	DefaultTotalTimeout = 30 * time.Minute
	// ImageAttachMaxBytes caps the per-file size for the temp-image
	// path used by image.attach. Nothing in Node enforces this today;
	// we add a guard so a malformed gigabyte base64 payload doesn't
	// fill /tmp.
	ImageAttachMaxBytes = 32 * 1024 * 1024
	// ImageDataURIMaxBytes caps the per-image conversion budget when
	// rewriting markdown image refs to data: URIs. Anything beyond is
	// left as a local-file ref to avoid runaway base64 in the SSE
	// stream.
	ImageDataURIMaxBytes = 8 * 1024 * 1024
)

// ImageBlock mirrors the FE shape (and harness.ImageBlock). The
// gateway-side prompt path needs MediaType + base64 data so it can
// materialise a temp file for the image.attach RPC.
type ImageBlock struct {
	MediaType string
	Base64    string
}

// OnPromptRequest is the callback signature invoked when Hermes asks
// for human input mid-turn. Type is one of:
//
//	"approval.request" / "clarify.request" / "sudo.request" / "secret.request"
//
// The payload is the raw event payload — the caller routes it back
// via Gateway.Send("approval.respond", …) etc.
type OnPromptRequest func(eventType string, payload map[string]any)

// PromptOpts captures the per-turn knobs. Zero values are valid:
//   - IdleMS = 0 → DefaultIdleTimeout
//   - TotalMS = 0 → DefaultTotalTimeout
//   - ImageBlocks nil → no attachments
//   - OnPromptRequest nil → mid-turn requests are dropped silently
//   - Presets default → presets.GetOrCreate behaviour
type PromptOpts struct {
	ImageBlocks     []ImageBlock
	Presets         Presets
	IdleTimeout     time.Duration
	TotalTimeout    time.Duration
	OnPromptRequest OnPromptRequest
}

// PromptResult is the SubmitPrompt return shape. Text is the
// image-processed assistant output; RawText is the unmodified body.
// Status is the message.complete payload.status string ("complete",
// "stopped", etc.) — empty when the event didn't carry one.
type PromptResult struct {
	Text    string
	RawText string
	Status  string
}

// SubmitPrompt drives one chat turn end-to-end. Subscribes to events
// for the resolved Hermes session, fires prompt.submit, accumulates
// message.delta payloads, and resolves once message.complete arrives.
//
// onDelta is called per inbound delta — wrap it in the adapter's
// emit closure to forward to the SSE stream.
//
// Returns a non-nil error on idle/total timeout, RPC failure, or an
// error event from Hermes. On error events the cached session id is
// dropped so the next call creates a fresh one (mirrors hermes.ts:441).
func SubmitPrompt(
	ctx context.Context,
	gw *Gateway,
	mgr *SessionManager,
	yhaSessionID string,
	partnerID string,
	text string,
	onDelta func(delta string),
	opts PromptOpts,
) (PromptResult, error) {
	if gw == nil || mgr == nil {
		return PromptResult{}, errors.New("hermes: gateway / session manager required")
	}
	if onDelta == nil {
		onDelta = func(string) {}
	}

	idleTimeout := opts.IdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = DefaultIdleTimeout
	}
	totalTimeout := opts.TotalTimeout
	if totalTimeout <= 0 {
		totalTimeout = DefaultTotalTimeout
	}

	if err := gw.EnsureRunning(ctx, EnsureRunningTimeout); err != nil {
		return PromptResult{}, err
	}

	hermesID, err := mgr.GetOrCreate(ctx, yhaSessionID, partnerID, opts.Presets)
	if err != nil {
		return PromptResult{}, err
	}

	// First-turn persona injection. Mirrors hermes.ts:358-368.
	effectiveText := assembleFirstTurn(text, mgr, hermesID)

	// Materialise image attachments. Each call gets its own temp file
	// so concurrent turns don't share buffers. Unlink in defer.
	tempPaths, err := attachImages(ctx, gw, hermesID, opts.ImageBlocks)
	defer cleanupTempFiles(tempPaths)
	if err != nil {
		return PromptResult{}, err
	}

	// Subscribe BEFORE submitting so we don't miss early deltas.
	ch, cancelSub := gw.Subscribe(hermesID)
	defer cancelSub()

	// Fire the prompt.submit RPC. The ack timeout is short (PromptSubmit
	// AckTimeout) — the actual turn waits on events, not on the response
	// frame.
	rpcCtx, rpcCancel := context.WithTimeout(ctx, PromptSubmitAckTimeout)
	if _, err := gw.Send(rpcCtx, "prompt.submit", map[string]any{
		"session_id": hermesID,
		"text":       effectiveText,
	}, PromptSubmitAckTimeout); err != nil {
		rpcCancel()
		return PromptResult{}, err
	}
	rpcCancel()

	// Event loop with dual watchdogs.
	totalT := time.NewTimer(totalTimeout)
	defer totalT.Stop()
	idleT := time.NewTimer(idleTimeout)
	defer idleT.Stop()

	var accum strings.Builder
	for {
		select {
		case <-ctx.Done():
			return PromptResult{RawText: accum.String()}, ctx.Err()
		case <-totalT.C:
			return PromptResult{RawText: accum.String()},
				fmt.Errorf("hermes: prompt total-timeout after %s", totalTimeout)
		case <-idleT.C:
			return PromptResult{RawText: accum.String()},
				fmt.Errorf("hermes: prompt idle-timeout after %s of silence", idleTimeout)
		case evt, ok := <-ch:
			if !ok {
				return PromptResult{RawText: accum.String()},
					errors.New("hermes: event channel closed before completion")
			}
			// Any event for this session resets the idle watchdog.
			if !idleT.Stop() {
				select {
				case <-idleT.C:
				default:
				}
			}
			idleT.Reset(idleTimeout)

			switch evt.Type {
			case "message.delta":
				if delta := stringField(evt.Payload, "text"); delta != "" {
					accum.WriteString(delta)
					onDelta(delta)
				}
			case "message.complete":
				raw := stringField(evt.Payload, "text")
				if raw == "" {
					raw = accum.String()
				}
				return PromptResult{
					Text:    processHermesImages(raw),
					RawText: raw,
					Status:  stringFieldOrDefault(evt.Payload, "status", "complete"),
				}, nil
			case "approval.request", "clarify.request", "sudo.request", "secret.request":
				if opts.OnPromptRequest != nil {
					opts.OnPromptRequest(evt.Type, evt.Payload)
				}
			case "error":
				// Drop the session on error so the next turn starts
				// fresh. Mirrors hermes.ts:441.
				mgr.Drop(yhaSessionID, partnerID)
				msg := stringFieldOrDefault(evt.Payload, "message", "Hermes agent error")
				return PromptResult{RawText: accum.String()}, errors.New(msg)
			}
		}
	}
}

// assembleFirstTurn folds the queued persona prompt (if any) into the
// user message. Subsequent turns reuse the same Hermes session and
// don't re-inject — the model already has the persona in context.
// Mirrors hermes.ts:355-368, but drops the importantFooter /
// cwd-context-footer hooks (those live on the Node side; the Go
// gateway doesn't own that pipeline yet — see parity-gap report).
func assembleFirstTurn(text string, mgr *SessionManager, hermesID string) string {
	persona, ok := mgr.TakePendingSysPrompt(hermesID)
	if !ok || persona == "" {
		return text
	}
	var b strings.Builder
	b.WriteString("[Persona Instructions]\n")
	b.WriteString(persona)
	b.WriteString("\n\n---\n\n[User]\n")
	b.WriteString(text)
	return b.String()
}

// attachImages materialises each image block to a temp file and fires
// image.attach. Errors on an individual block are warnings — we keep
// going so a single bad image doesn't fail the whole turn. The
// returned slice is every temp path that needs cleanup (caller defers
// cleanupTempFiles on the returned slice regardless of error).
func attachImages(ctx context.Context, gw *Gateway, hermesID string, blocks []ImageBlock) ([]string, error) {
	if len(blocks) == 0 {
		return nil, nil
	}
	tmpDir := os.TempDir()
	tempPaths := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.Base64 == "" {
			continue
		}
		decoded, err := decodeBase64Capped(block.Base64, ImageAttachMaxBytes)
		if err != nil {
			gw.log.Warn("hermes.image-decode-failed", "err", err)
			continue
		}
		ext := extForMediaType(block.MediaType)
		path, err := writeTempImage(tmpDir, ext, decoded)
		if err != nil {
			gw.log.Warn("hermes.image-write-failed", "err", err)
			continue
		}
		if _, err := gw.Send(ctx, "image.attach", map[string]any{
			"session_id": hermesID,
			"path":       path,
		}, ImageAttachTimeout); err != nil {
			gw.log.Warn("hermes.image-attach-failed", "err", err)
			// Still queue for cleanup so /tmp doesn't leak.
			tempPaths = append(tempPaths, path)
			continue
		}
		tempPaths = append(tempPaths, path)
	}
	return tempPaths, nil
}

// cleanupTempFiles unlinks every path; errors are swallowed (best-effort).
func cleanupTempFiles(paths []string) {
	for _, p := range paths {
		_ = os.Remove(p)
	}
}

func writeTempImage(dir, ext string, data []byte) (string, error) {
	if ext == "" {
		ext = "jpg"
	}
	name := fmt.Sprintf("yha-hermes-%d-%s.%s", time.Now().UnixNano(), randomSuffix(), ext)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func randomSuffix() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Fall back to a time-based stamp — collisions are still
		// vanishingly rare for our use case.
		return fmt.Sprintf("%x", time.Now().UnixNano()&0xFFFFFF)
	}
	return hex.EncodeToString(b[:])
}

func extForMediaType(mt string) string {
	mt = strings.ToLower(strings.TrimSpace(mt))
	if mt == "" {
		return "jpg"
	}
	if idx := strings.IndexByte(mt, '/'); idx >= 0 {
		sub := mt[idx+1:]
		// Normalise jpeg → jpg to match the Node side.
		if sub == "jpeg" {
			return "jpg"
		}
		return sub
	}
	return "jpg"
}

func decodeBase64Capped(s string, capBytes int) ([]byte, error) {
	if len(s) > capBytes*4/3+16 {
		return nil, fmt.Errorf("hermes: image payload exceeds %d bytes (base64 in)", capBytes)
	}
	decoded, err := base64DecodeStrict(s)
	if err != nil {
		return nil, err
	}
	if len(decoded) > capBytes {
		return nil, fmt.Errorf("hermes: image payload exceeds %d bytes (decoded)", capBytes)
	}
	return decoded, nil
}

// base64DecodeStrict accepts std-encoding base64 input. The FE pages
// always supply standard-encoded payloads (no URL-safe variant).
func base64DecodeStrict(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

func encodeBase64(b []byte) string {
	return base64.StdEncoding.EncodeToString(b)
}

// ── Markdown image post-processing ─────────────────────────────────────────

var imageRefRegex = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)

var imageMimeByExt = map[string]string{
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"gif":  "image/gif",
	"webp": "image/webp",
	"svg":  "image/svg+xml",
}

// processHermesImages replaces local file path references in
// markdown image tags with base64 data URIs. URLs (http/https) and
// existing data: URIs pass through unchanged. Files that don't exist
// (or exceed ImageDataURIMaxBytes) are left as-is.
//
// Mirrors _processHermesImages in hermes.ts:29-43.
func processHermesImages(text string) string {
	if text == "" {
		return text
	}
	home := os.Getenv("HOME")
	if home == "" {
		if hd, err := os.UserHomeDir(); err == nil {
			home = hd
		}
	}
	return imageRefRegex.ReplaceAllStringFunc(text, func(match string) string {
		m := imageRefRegex.FindStringSubmatch(match)
		if len(m) != 3 {
			return match
		}
		alt, src := m[1], m[2]
		if isURLOrData(src) {
			return match
		}
		filePath := src
		if strings.HasPrefix(filePath, "~") {
			filePath = filepath.Join(home, filePath[1:])
		}
		info, err := os.Stat(filePath)
		if err != nil {
			return match
		}
		if info.Size() > ImageDataURIMaxBytes {
			return match
		}
		data, err := os.ReadFile(filePath)
		if err != nil {
			return match
		}
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(filePath), "."))
		if ext == "" {
			ext = "png"
		}
		mime, ok := imageMimeByExt[ext]
		if !ok {
			mime = "image/png"
		}
		return "![" + alt + "](data:" + mime + ";base64," + encodeBase64(data) + ")"
	})
}

func isURLOrData(src string) bool {
	low := strings.ToLower(src)
	return strings.HasPrefix(low, "http://") ||
		strings.HasPrefix(low, "https://") ||
		strings.HasPrefix(low, "data:")
}

// ── Tiny helpers ───────────────────────────────────────────────────────────

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func stringFieldOrDefault(m map[string]any, key, def string) string {
	if s := stringField(m, key); s != "" {
		return s
	}
	return def
}

func unmarshalResult(raw json.RawMessage, v any) error {
	if len(raw) == 0 {
		return errors.New("hermes: empty RPC result")
	}
	return json.Unmarshal(raw, v)
}
