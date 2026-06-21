// Package broadcast is the Go port of bridge/modules/multichat-broadcast.
//
// It runs each participant in a multi-participant session through their
// assigned harness — sequentially by default, or concurrently in
// "versus" mode — and emits every participant's reply onto the same
// outer stream tagged with author metadata. A leading `@name` in a
// reply re-dispatches to that participant via the forward-mention
// chain (forward.go), bounded by the configured hop limit.
//
// The runner is opt-in. The wiring agent registers
// stream.HarnessAdapters["broadcast"] only when YHA_GO_BROADCAST=1 is
// set; without that flag the request reverts to the existing Phase 5
// proxy path and Node owns the broadcast.
//
// File map:
//
//   - participants.go — EmployeeRecord + FileEmployeeLoader (frontmatter
//     parser + partners.json fallback)
//   - runner.go        — Runner.RunChain: per-employee loop with the
//     adapter-routing switch (claude-binary / codex /
//     openclaw / hermes / direct-api)
//   - forward.go       — runForwardMentionChain: leading-`@name` reply
//     re-dispatch with hop-limit
//   - request.go       — shaping helpers (identity / important / cwd
//     footer, allowed-tools narrowing)
//
// The runner builds on harness.Request / harness.Result, mirroring the
// types every adapter already consumes. It does NOT persist per-employee
// turn history into bridge/sessions/<sid>.json yet — that stays
// Node-owned for now (see runner.go's Run loop for the gap comment).
package broadcast

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// EmployeeRecord is the full subset of the Node-side employee
// frontmatter the broadcast runner needs. Only fields the per-employee
// loop reads (model, partner-routing, tool capabilities, identity
// metadata) live here — auxiliary FE fields (fullName, fallback model,
// timestamps) are intentionally omitted.
type EmployeeRecord struct {
	// Identity. Name and Role are surfaced via the author chunk; ID
	// keys per-employee history forks + cost slices.
	ID          string
	Name        string
	Role        string
	SymbolColor string

	// DefaultModel is the model id the FE picker selected for this
	// employee. Empty = fall back to the session's chosen Model.
	DefaultModel string

	// DefaultModelProvider is the FE's explicit provider hint that
	// rides alongside DefaultModel (e.g. "Anthropic Subscription").
	// Empty = let the adapter auto-pick.
	DefaultModelProvider string

	// SystemPromptPreset is the preset name the employee runs under
	// ("CEOdave", "RudeMax", …). Empty = the session default preset.
	SystemPromptPreset string

	// PartnerType / PartnerID populate when the participant is a
	// gateway-routed partner. PartnerType is "hermes" / "openclaw" /
	// future types. PartnerID is the partners.json id.
	PartnerType string
	PartnerID   string

	// ToolSetPreset is the tool allow-list bucket the employee runs
	// under. Empty = full catalog.
	ToolSetPreset string

	// CapVision is "on" / "off" / "" (default on). Off-vision blocks
	// the runner from passing ImageBlocks to this employee.
	CapVision string

	// CapTools is "on" / "off" / "filter" / "" (default filter — the
	// ToolSetPreset's allow-list applies). "off" forces an empty
	// allow-list; "on" forces the full catalog.
	CapTools string
}

// EmployeeLoader is the read-only surface the runner uses to fetch
// employee records by id. Production wires *FileEmployeeLoader (reads
// bridge/employees/<id>.md frontmatter + bridge/partners.json); tests
// pass a scripted map.
type EmployeeLoader interface {
	Load(id string) (*EmployeeRecord, error)
}

// FileEmployeeLoader is the production EmployeeLoader. Reads each
// employee's frontmatter from bridge/employees/<id>.md and, when the
// id matches an enabled partners.json entry instead, returns a
// partner-typed EmployeeRecord with empty model fields.
//
// Mirrors parseFrontmatter() in
// go-core/internal/stream/participants.go so the two resolvers stay
// observationally consistent — frontmatter shape changes in Node need
// to land in both files.
type FileEmployeeLoader struct {
	bridgeRoot string
}

// NewFileEmployeeLoader constructs a loader rooted at bridgeRoot
// (typically the daemon's bridge/ path).
func NewFileEmployeeLoader(bridgeRoot string) *FileEmployeeLoader {
	return &FileEmployeeLoader{bridgeRoot: bridgeRoot}
}

// Load returns the employee record for id. Lookup order matches
// Node's resolveTargetAgent: employee frontmatter first, partners.json
// second. Missing id → (nil, nil) so the runner can skip silently.
func (l *FileEmployeeLoader) Load(id string) (*EmployeeRecord, error) {
	id = strings.TrimSpace(id)
	if l == nil || strings.TrimSpace(l.bridgeRoot) == "" || id == "" {
		return nil, nil
	}
	if rec, err := l.loadEmployee(id); err != nil {
		return nil, err
	} else if rec != nil {
		return rec, nil
	}
	return l.loadPartner(id)
}

func (l *FileEmployeeLoader) loadEmployee(id string) (*EmployeeRecord, error) {
	path := filepath.Join(l.bridgeRoot, "employees", id+".md")
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	fm := parseFrontmatter(raw)
	empID := firstNonEmpty(fm["id"], id)
	return &EmployeeRecord{
		ID:                   empID,
		Name:                 firstNonEmpty(fm["name"], empID),
		Role:                 fm["role"],
		SymbolColor:          fm["symbolColor"],
		DefaultModel:         fm["defaultModel"],
		DefaultModelProvider: fm["defaultModelProvider"],
		SystemPromptPreset:   fm["systemPromptPreset"],
		ToolSetPreset:        fm["toolSetPreset"],
		CapVision:            fm["capVision"],
		CapTools:             fm["capTools"],
	}, nil
}

type persistedPartner struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	SymbolColor string `json:"symbolColor"`
	Enabled     bool   `json:"enabled"`
}

func (l *FileEmployeeLoader) loadPartner(id string) (*EmployeeRecord, error) {
	path := filepath.Join(l.bridgeRoot, "partners.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var partners []persistedPartner
	if err := json.Unmarshal(raw, &partners); err != nil {
		return nil, err
	}
	for _, p := range partners {
		if !p.Enabled || strings.TrimSpace(p.ID) != id {
			continue
		}
		return &EmployeeRecord{
			ID:          p.ID,
			Name:        firstNonEmpty(p.Name, p.ID),
			SymbolColor: p.SymbolColor,
			PartnerType: strings.TrimSpace(p.Type),
			PartnerID:   p.ID,
		}, nil
	}
	return nil, nil
}

// parseFrontmatter is the same minimal `--- ... ---` YAML-ish parser
// the stream package uses, duplicated locally to avoid a cross-package
// import dependency. Keys are colon-separated; values are trimmed.
func parseFrontmatter(raw []byte) map[string]string {
	text := string(raw)
	if !strings.HasPrefix(text, "---\n") {
		return map[string]string{}
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return map[string]string{}
	}
	block := text[4 : 4+end]
	out := map[string]string{}
	for _, line := range strings.Split(block, "\n") {
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])
		if key != "" {
			out[key] = val
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
