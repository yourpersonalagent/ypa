package codex

// effort.go — mapEffortToReasoning.
//
// The harness.Request carries an Effort field that's one of the YHA
// EFFORT_LEVELS (bridge/providers/core.ts:183):
//
//	low | medium | high | xhigh | max
//
// The Codex CLI's `reasoning_effort` config knob accepts:
//
//	minimal | low | medium | high
//
// This file maps the former to the latter. The mapping is intentionally
// coarse — Codex doesn't have a 5-step scale, so xhigh and max both
// fold to "high". A literal "none" / "off" / "" passthrough returns
// "" so buildArgs can omit the `-c reasoning_effort=...` flag entirely
// (Codex falls back to its config-file default).
//
// NOTE: the canonical TS provider (bridge/providers/codex.ts) doesn't
// currently expose effort tuning — Phase 6 adds this hook on the Go
// side per the harness contract. When the Node-side ports its own
// effort handling, the mapping below is the source of truth.

import "strings"

// mapEffortToReasoning maps a YHA effort level to a Codex
// reasoning_effort value. Returns "" when the input shouldn't trigger
// any -c reasoning_effort= flag.
//
// Cases:
//
//	""          → ""           (no flag — Codex uses config default)
//	"none"      → "none"       (explicit opt-out; buildArgs skips reasoning_summaries)
//	"off"       → "none"       (alias for "none")
//	"low"       → "low"
//	"medium"    → "medium"
//	"high"      → "high"
//	"xhigh"     → "high"       (Codex caps at "high")
//	"max"       → "high"
//	"minimal"   → "minimal"    (passthrough; not a YHA level but the
//	                            Codex CLI accepts it, so allow it)
//	anything else → ""         (defensive — don't pass garbage to -c)
func mapEffortToReasoning(effort string) string {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "":
		return ""
	case "none", "off":
		return "none"
	case "minimal":
		return "minimal"
	case "low":
		return "low"
	case "medium":
		return "medium"
	case "high":
		return "high"
	case "xhigh", "max", "extra-high", "extrahigh":
		return "high"
	default:
		return ""
	}
}
