// session.go — per-(yhaSessionID, partnerID) Hermes session map.
//
// Mirrors the sessionMap + pendingSysPrompt logic in hermes.ts:
//   - The composite key is "<yhaSessionID>::<partnerID|default>". Two
//     Hermes partner records inside one YHA chat get independent
//     Hermes sessions.
//   - GetOrCreate is lazy: first call issues session.create on the
//     gateway; subsequent calls reuse the cached Hermes session id.
//   - A system-prompt preset queued at create time is held in a
//     per-Hermes-session map and consumed by the first SubmitPrompt
//     (see prompt.go) — Hermes has no global config API, so persona
//     instructions are folded into the first user message instead.
//   - Drop best-effort closes the session on the gateway side.

package hermes

import (
	"context"
	"errors"
	"strings"
	"sync"
)

// Presets is the preset bundle passed into GetOrCreate. Mirrors the
// {model, systemPrompt} arg in hermes.ts:251-282.
type Presets struct {
	Model        string
	SystemPrompt string
}

// SessionManager owns the per-(yhaSessionID, partnerID) session map.
// One instance per Gateway. Safe for concurrent calls.
type SessionManager struct {
	gw *Gateway

	mu               sync.Mutex
	sessionMap       map[string]string // composite key → hermes session id
	pendingSysPrompt map[string]string // hermes session id → persona text
}

// NewSessionManager builds an empty manager backed by gw.
func NewSessionManager(gw *Gateway) *SessionManager {
	return &SessionManager{
		gw:               gw,
		sessionMap:       map[string]string{},
		pendingSysPrompt: map[string]string{},
	}
}

// compositeKey returns the storage key used to bucket sessions. The
// "default" fallback mirrors hermes.ts:89-91 — empty partner id is
// rare but should not collide with other partner records.
func compositeKey(yhaSessionID, partnerID string) string {
	if partnerID == "" {
		partnerID = "default"
	}
	return yhaSessionID + "::" + partnerID
}

// GetOrCreate returns the cached Hermes session id for the given
// (yhaSessionID, partnerID) pair, creating one via gateway RPC if
// absent. presets.SystemPrompt is queued for first-turn injection
// (see PendingSysPrompt); presets.Model is applied via a /model
// slash command best-effort — failures are warnings, not errors.
func (m *SessionManager) GetOrCreate(ctx context.Context, yhaSessionID, partnerID string, presets Presets) (string, error) {
	if m.gw == nil {
		return "", errors.New("hermes: nil gateway")
	}
	key := compositeKey(yhaSessionID, partnerID)
	m.mu.Lock()
	if existing, ok := m.sessionMap[key]; ok {
		m.mu.Unlock()
		return existing, nil
	}
	m.mu.Unlock()

	if err := m.gw.EnsureRunning(ctx, EnsureRunningTimeout); err != nil {
		return "", err
	}

	raw, err := m.gw.Send(ctx, "session.create", map[string]any{}, SessionCreateTimeout)
	if err != nil {
		return "", err
	}
	var resp struct {
		SessionID string `json:"session_id"`
	}
	if err := unmarshalResult(raw, &resp); err != nil {
		return "", err
	}
	if resp.SessionID == "" {
		return "", errors.New("hermes: session.create returned no session_id")
	}

	m.mu.Lock()
	// Re-check in case of a race; first writer wins.
	if existing, ok := m.sessionMap[key]; ok {
		m.mu.Unlock()
		return existing, nil
	}
	m.sessionMap[key] = resp.SessionID
	if sp := strings.TrimSpace(presets.SystemPrompt); sp != "" {
		m.pendingSysPrompt[resp.SessionID] = sp
	}
	m.mu.Unlock()

	m.gw.log.Info("hermes.session-created",
		"yhaSessionId", yhaSessionID, "partnerId", partnerID,
		"hermesId", resp.SessionID)

	// Best-effort model apply. Mirrors hermes.ts:275-281.
	if model := strings.TrimSpace(presets.Model); model != "" {
		if _, err := m.gw.Send(ctx, "slash.exec", map[string]any{
			"session_id": resp.SessionID,
			"command":    "/model " + model,
		}, SlashExecTimeout); err != nil {
			m.gw.log.Warn("hermes.model-apply-failed", "model", model, "err", err)
		}
	}

	return resp.SessionID, nil
}

// Drop removes the cached mapping for (yhaSessionID, partnerID) and
// best-effort closes the Hermes session on the gateway side.
// Mirrors hermes.ts:310-317.
func (m *SessionManager) Drop(yhaSessionID, partnerID string) {
	key := compositeKey(yhaSessionID, partnerID)
	m.mu.Lock()
	hermesID, ok := m.sessionMap[key]
	delete(m.sessionMap, key)
	delete(m.pendingSysPrompt, hermesID)
	m.mu.Unlock()
	if !ok || hermesID == "" {
		return
	}
	if m.gw == nil || !m.gw.IsRunning() {
		return
	}
	// Best-effort. Discard error.
	ctx, cancel := context.WithTimeout(context.Background(), DefaultRPCTimeout)
	defer cancel()
	_, _ = m.gw.Send(ctx, "session.close", map[string]any{"session_id": hermesID}, DefaultRPCTimeout)
}

// HermesID returns the cached Hermes session id without creating one.
// Empty string if absent.
func (m *SessionManager) HermesID(yhaSessionID, partnerID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessionMap[compositeKey(yhaSessionID, partnerID)]
}

// TakePendingSysPrompt returns and clears the queued persona prompt
// for the given Hermes session id. Returns ("", false) when none is
// queued. Called by prompt.go on the first turn after a fresh create.
func (m *SessionManager) TakePendingSysPrompt(hermesID string) (string, bool) {
	if hermesID == "" {
		return "", false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	sp, ok := m.pendingSysPrompt[hermesID]
	if ok {
		delete(m.pendingSysPrompt, hermesID)
	}
	return sp, ok
}

// Count returns the number of live mappings. Mirrors hermes.ts:479.
func (m *SessionManager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessionMap)
}
