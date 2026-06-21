// Request shaping helpers — port of the per-employee preset/tools/image
// composition Node's runEmployeeInChain does before handing off to a
// harness. Each helper returns a deterministic value so unit tests can
// assert exact strings.
//
// IMPORTANT-memory + CWD-context footers are now wired through to the
// stream package's BuildImportantFooter / BuildCwdContextFooter helpers
// (per §8.3 of GoCoreReport.md). The bridgeRoot scoping mirrors the
// direct-API path so every employee turn carries byte-identical footers
// to the Node-served path, with no callback hop per employee.

package broadcast

import (
	"strings"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/stream"
)

// IdentityNote returns the broadcast identity blurb appended to the
// system prompt so the model knows which persona it's speaking as.
// Mirrors multiAgentSystemNote(emp.name) on the Node side.
//
// Empty name → empty string so callers can join without producing
// "You are speaking as ." artefacts.
func IdentityNote(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	return "You are speaking as " + name + " in a multi-participant chat. Stay in character; greet, reason, and reply as that persona only."
}

// ImportantFooter returns the "IMPORTANT — shared memory across
// agents" block to append to every employee's system prompt. Reads
// bridge/important-memory.json via stream.BuildImportantFooter so the
// broadcast and direct-API paths produce byte-identical footers with
// no Node callback hop per employee. Empty bridgeRoot returns "".
func ImportantFooter(bridgeRoot string) string {
	return stream.BuildImportantFooter(bridgeRoot)
}

// CWDContextFooter returns the per-session CWD-context footer
// ("## CWD context — only for working directory <cwd>") for the
// chain's current working directory. Reads
// bridge/cwd-context-memory.json via stream.BuildCwdContextFooter so
// broadcast employees see the same memory entries the direct-API
// path emits. Empty bridgeRoot or empty cwd returns "".
func CWDContextFooter(bridgeRoot, cwd string) string {
	return stream.BuildCwdContextFooter(bridgeRoot, cwd)
}

// ComposePreset folds an identity note + important footer + cwd
// footer into a base preset string, with double-newline separators.
// Empty fragments are silently skipped so the result has no orphan
// blank lines.
func ComposePreset(base string, identity, important, cwd string) string {
	parts := make([]string, 0, 4)
	if v := strings.TrimSpace(base); v != "" {
		parts = append(parts, v)
	}
	if v := strings.TrimSpace(identity); v != "" {
		parts = append(parts, v)
	}
	if v := strings.TrimSpace(important); v != "" {
		parts = append(parts, v)
	}
	if v := strings.TrimSpace(cwd); v != "" {
		parts = append(parts, v)
	}
	return strings.Join(parts, "\n\n")
}

// AllowedToolsForEmployee mirrors the Node runner's per-employee tool
// narrowing: capTools=="off" forces an empty list; capTools=="on"
// returns nil (full catalog); anything else uses ToolSetPreset's
// allow-list (passed in by the caller — the registry lookup happens
// outside the broadcast package).
//
// Returns:
//   - nil   → full catalog
//   - []{}  → no tools allowed (length zero)
//   - other → the supplied preset-allowed list, cloned
func AllowedToolsForEmployee(rec *EmployeeRecord, presetTools []string) []string {
	if rec == nil {
		return nil
	}
	switch strings.ToLower(strings.TrimSpace(rec.CapTools)) {
	case "off":
		return []string{}
	case "on":
		return nil
	}
	if rec.ToolSetPreset == "" {
		return nil
	}
	if len(presetTools) == 0 {
		return nil
	}
	out := make([]string, len(presetTools))
	copy(out, presetTools)
	return out
}

// ImagesForEmployee returns the image blocks the runner should pass
// to the employee's harness call. capVision=="off" filters all
// images; anything else passes them through unchanged.
func ImagesForEmployee(rec *EmployeeRecord, images []harness.ImageBlock) []harness.ImageBlock {
	if rec == nil {
		return images
	}
	if strings.EqualFold(strings.TrimSpace(rec.CapVision), "off") {
		return nil
	}
	return images
}

// EffectiveModel returns the model id the employee should run under:
//   - emp.DefaultModel if set
//   - otherwise sessionModel
//
// Empty inputs are handled gracefully — callers may receive an empty
// string when neither side set a model and the adapter should fall
// back to its own default.
func EffectiveModel(rec *EmployeeRecord, sessionModel string) string {
	if rec != nil && strings.TrimSpace(rec.DefaultModel) != "" {
		return rec.DefaultModel
	}
	return strings.TrimSpace(sessionModel)
}

// EffectiveSystemMode mirrors the Node runner's "force replace by
// default" — when the session didn't set a system mode, broadcast
// employees use "replace" so each persona's preset reaches the model
// instead of being appended to a shared system block.
func EffectiveSystemMode(sessionMode string) string {
	if v := strings.TrimSpace(sessionMode); v != "" {
		return v
	}
	return "replace"
}
