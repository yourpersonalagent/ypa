package stream

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var leadingMentionPattern = regexp.MustCompile(`(?i)^@([a-z0-9_-]+)\s*`)

// ParticipantResolver loads the persisted session participant metadata
// the route uses to dispatch employee / partner / broadcast adapters.
// Was originally co-developed with Node's /v1/stream/ — Phase 7
// deleted that route, the resolver itself stayed in Go.
type ParticipantResolver interface {
	Resolve(sessionID, input string) (ParticipantRouteContext, error)
}

// ParticipantRouteContext is the resolved session-level routing state
// for one /v1/stream-direct/ request.
type ParticipantRouteContext struct {
	HasParticipants bool
	GroupMode       string
	Broadcast       bool
	ViaMention      bool
	Input           string
	Target          *ParticipantTarget
	// ParticipantIDs is the raw participant id list from the persisted
	// session, in declaration order. The broadcast / versus adapter
	// uses these to fan out the chain; single-target paths ignore.
	ParticipantIDs []string
}

// ParticipantTarget is the minimal employee / partner identity the
// stream route needs to decide whether an in-process harness can own a
// participant-routed request.
type ParticipantTarget struct {
	ID          string
	Name        string
	PartnerType string
	PartnerID   string
	// Employee-level capability gates. Mirrors the frontmatter in
	// bridge/employees/*.md (capVision / capTools / capReasoning).
	// Empty string = "on" / "let the request decide"; "off" forces
	// the corresponding feature off for this employee regardless of
	// FE state. "filter" on capTools narrows the tool catalog to the
	// employee's toolSetPreset. Pre-refactor Node enforced these in
	// chat.ts:471-473 just before passing AllowedTools / ImageBlocks
	// to the provider.
	CapVision    string
	CapTools     string
	CapReasoning string
	// ToolSetPreset is the employee's narrowed tool set name (used
	// when capTools is "filter"). Looked up against config.toolSets.
	ToolSetPreset string
	// SystemPromptPreset / Skills / Model overrides — the employee
	// can pin its own model & system prompt; the route folds these
	// over the FE-supplied values when present.
	SystemPromptPreset string
	Model              string
	SkillSet           string
}

// FileParticipantResolver mirrors Node's resolveTargetAgent() by
// reading the same persisted bridge files: sessions under
// bridge/sessions/ (or SQLite when set), employees under
// bridge/employees/, and enabled partners from bridge/partners.json.
//
// Post-Step-5 the session file path may not exist; WithSQLite installs
// the canonical SQLite reader and loadSession prefers it. JSON read
// remains as a defensive fallback for setups that haven't activated
// SQLite yet.
type FileParticipantResolver struct {
	bridgeRoot string
	sqlite     *SQLiteFinalizer // optional; nil = JSON-only fallback
}

func NewFileParticipantResolver(bridgeRoot string) *FileParticipantResolver {
	return &FileParticipantResolver{bridgeRoot: bridgeRoot}
}

// WithSQLite installs a SQLite reader so loadSession can read
// participants + groupMode from the DB instead of bridge/sessions/<sid>.json.
// Nil is allowed and reverts to the JSON-only path.
func (r *FileParticipantResolver) WithSQLite(f *SQLiteFinalizer) *FileParticipantResolver {
	if r == nil {
		return nil
	}
	r.sqlite = f
	return r
}

func (r *FileParticipantResolver) Resolve(sessionID, input string) (ParticipantRouteContext, error) {
	if r == nil || strings.TrimSpace(r.bridgeRoot) == "" || strings.TrimSpace(sessionID) == "" {
		return ParticipantRouteContext{}, nil
	}

	session, err := r.loadSession(sessionID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ParticipantRouteContext{}, nil
		}
		return ParticipantRouteContext{}, err
	}
	if len(session.Participants) == 0 {
		return ParticipantRouteContext{}, nil
	}

	ctx := ParticipantRouteContext{
		HasParticipants: true,
		GroupMode:       normalizeGroupMode(session.GroupMode),
		Input:           strings.TrimSpace(input),
		ParticipantIDs:  append([]string(nil), session.Participants...),
	}

	if target, cleanInput := r.resolveMentionTarget(session.Participants, input); target != nil {
		ctx.Target = target
		ctx.ViaMention = true
		ctx.Input = cleanInput
		return ctx, nil
	}

	if ctx.GroupMode == "moderator" {
		target, err := r.lookupParticipant(firstParticipant(session.Participants))
		if err != nil {
			return ctx, err
		}
		ctx.Target = target
		return ctx, nil
	}

	targets, err := r.lookupParticipants(session.Participants)
	if err != nil {
		return ctx, err
	}
	if len(targets) == 0 {
		return ctx, nil
	}
	ctx.Broadcast = true
	if len(targets) == 1 {
		ctx.Target = targets[0]
	}
	return ctx, nil
}

type persistedSession struct {
	Participants []string `json:"participants"`
	GroupMode    string   `json:"groupMode"`
}

func (r *FileParticipantResolver) loadSession(sessionID string) (*persistedSession, error) {
	// SQLite first (Step 4 canonical); JSON fallback for installations
	// without an opened finalizer or for legacy archive lookups.
	if r != nil && r.sqlite != nil {
		if parts, gm, ok := r.sqlite.SessionParticipants(sessionID); ok {
			return &persistedSession{Participants: parts, GroupMode: gm}, nil
		}
	}
	path := filepath.Join(r.bridgeRoot, "sessions", sessionFileName(sessionID))
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var session persistedSession
	if err := json.Unmarshal(raw, &session); err != nil {
		return nil, err
	}
	return &session, nil
}

func sessionFileName(sessionID string) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= 'A' && r <= 'Z':
			return r
		case r >= '0' && r <= '9':
			return r
		case r == '-' || r == '_':
			return r
		default:
			return '_'
		}
	}, sessionID)
	if len(safe) > 80 {
		safe = safe[:80]
	}
	return safe + ".json"
}

func normalizeGroupMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "moderator":
		return "moderator"
	case "versus":
		return "versus"
	default:
		return "sequential"
	}
}

func firstParticipant(ids []string) string {
	if len(ids) == 0 {
		return ""
	}
	return strings.TrimSpace(ids[0])
}

func (r *FileParticipantResolver) resolveMentionTarget(participants []string, input string) (*ParticipantTarget, string) {
	trimmed := strings.TrimLeft(input, " \t\r\n")
	match := leadingMentionPattern.FindStringSubmatch(trimmed)
	if len(match) < 2 {
		return nil, ""
	}
	targetToken := strings.ToLower(strings.TrimSpace(match[1]))
	for _, id := range participants {
		target, err := r.lookupParticipant(id)
		if err != nil || target == nil {
			continue
		}
		if strings.EqualFold(target.ID, targetToken) || strings.EqualFold(target.Name, targetToken) {
			clean := strings.TrimSpace(trimmed[len(match[0]):])
			if clean == "" {
				clean = strings.TrimSpace(trimmed)
			}
			return target, clean
		}
	}
	return nil, ""
}

func (r *FileParticipantResolver) lookupParticipants(ids []string) ([]*ParticipantTarget, error) {
	out := make([]*ParticipantTarget, 0, len(ids))
	for _, id := range ids {
		target, err := r.lookupParticipant(id)
		if err != nil {
			return nil, err
		}
		if target != nil {
			out = append(out, target)
		}
	}
	return out, nil
}

func (r *FileParticipantResolver) lookupParticipant(id string) (*ParticipantTarget, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil
	}
	if target, err := r.lookupEmployee(id); err != nil {
		return nil, err
	} else if target != nil {
		return target, nil
	}
	return r.lookupPartner(id)
}

func (r *FileParticipantResolver) lookupEmployee(id string) (*ParticipantTarget, error) {
	path := filepath.Join(r.bridgeRoot, "employees", id+".md")
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	frontmatter := parseFrontmatter(raw)
	empID := firstNonEmpty(frontmatter["id"], id)
	return &ParticipantTarget{
		ID:                 empID,
		Name:               firstNonEmpty(frontmatter["name"], empID),
		CapVision:          strings.ToLower(strings.TrimSpace(frontmatter["capVision"])),
		CapTools:           strings.ToLower(strings.TrimSpace(frontmatter["capTools"])),
		CapReasoning:       strings.ToLower(strings.TrimSpace(frontmatter["capReasoning"])),
		ToolSetPreset:      strings.TrimSpace(frontmatter["toolSetPreset"]),
		SystemPromptPreset: strings.TrimSpace(frontmatter["systemPromptPreset"]),
		Model:              strings.TrimSpace(frontmatter["model"]),
		SkillSet:           strings.TrimSpace(frontmatter["skillSet"]),
	}, nil
}

type persistedPartner struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

func (r *FileParticipantResolver) lookupPartner(id string) (*ParticipantTarget, error) {
	path := filepath.Join(r.bridgeRoot, "partners.json")
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
	for _, partner := range partners {
		if !partner.Enabled || strings.TrimSpace(partner.ID) != id {
			continue
		}
		return &ParticipantTarget{
			ID:          partner.ID,
			Name:        firstNonEmpty(partner.Name, partner.ID),
			PartnerType: strings.TrimSpace(partner.Type),
			PartnerID:   partner.ID,
		}, nil
	}
	return nil, nil
}

func parseFrontmatter(raw []byte) map[string]string {
	text := string(raw)
	if !strings.HasPrefix(text, "---\n") {
		return nil
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return nil
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
