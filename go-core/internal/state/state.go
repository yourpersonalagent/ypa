// Package state is the Go port of bridge/core/state.ts.
//
// Owns: config (config.json) loading + saving, BRIDGE_INTERNAL_KEY
// generation, atomic file writes, env-var rewrites.
//
// Phase 2a status: implementation present, NOT yet wired into the
// daemon's request path. Phase 2b/2c flips the cutover so Go is the
// source of truth.
//
// Concurrency model
//   - Config: RWMutex around a Config struct value. Save writes a fresh
//     temp file then atomically renames.
//
// Differences vs the TS version
//   - Claude/Codex binary auto-detection lives in tools/ (Phase 2c)
//     because Go core won't spawn those binaries until then.
//   - modelCaches (Anthropic, OpenAI, ...) stays in Node — those are
//     populated by provider modules that aren't ported.
//   - Per-session runtime maps (claudeSessions, chatHistory,
//     activeStreams, activeProcesses) stay in Node — Go core doesn't
//     own session lifecycle.
package state

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/yha/core/internal/logger"
)

// Provider env-var mapping (mirrors PROVIDER_ENV_KEYS in state.ts).
var ProviderEnvKeys = map[string]string{
	"Anthropic":    "ANTHROPIC_API_KEY",
	"OpenAI":       "OPENAI_API_KEY",
	"OpenAI-Image": "OPENAI_API_KEY",
	"Google":       "GOOGLE_API_KEY",
	"Grok":         "GROK_API_KEY",
	"OpenRouter":   "OPENROUTER_API_KEY",
	"DeepSeek":     "DEEPSEEK_API_KEY",
	"NVIDIA":       "NVIDIA_API_KEY",
}

// Config matches the on-disk shape of bridge/config.json.
//
// Providers and Defaults are kept as raw JSON-decoded maps because the
// TS shape is dynamic (defaults.model, defaults.rateLimit.<provider>.rpm,
// defaults.claudeInstances, etc.). Round-trip safety is the priority —
// nothing the Go core understands today should drop fields it doesn't.
type Config struct {
	Providers []map[string]any `json:"providers"`
	Defaults  map[string]any   `json:"defaults"`
	// SkillSets is the top-level `skillSets` map from bridge/config.json:
	// {"<set-name>": ["<skill-file-stem>", ...]}. Used by the stream
	// route to expand a FE-supplied SkillSet into the actual skill
	// markdown files under bridge/skills/. Mirrors Node's
	// config.skillSets read by bridge/chat/helpers.ts:resolveSkills.
	SkillSets map[string][]string `json:"skillSets,omitempty"`
	// ToolSets is the top-level `toolSets` map from bridge/config.json:
	// {"<set-name>": ["<tool-id>", ...]}. The stream route expands a
	// FE-supplied ToolSetPreset body field into the AllowedTools list
	// via the same lookup Node's old chat.ts:466-469 did.
	ToolSets map[string][]string `json:"toolSets,omitempty"`
	// Presets is the top-level `presets` map — system-prompt named
	// snippets. The stream route reads config.defaults.preset (a name)
	// and resolves it through this map for the default-system-prompt
	// fallback, plus uses it on SystemMode="append" to prepend the
	// default before the per-turn preset.
	Presets map[string]string `json:"presets,omitempty"`
}

// LoadConfig reads bridge/config.json. Missing or unreadable files
// produce an empty config (matches the TS try/catch fallback).
//
// API keys from .env are injected into the in-memory copy so callers
// can read them via Provider("Anthropic").APIKey without touching
// process.env directly. Save() strips them before persisting.
func LoadConfig(path string) (Config, error) {
	c := Config{Providers: []map[string]any{}, Defaults: map[string]any{}}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return c, nil
		}
		return c, fmt.Errorf("state: read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("state: parse %s: %w", path, err)
	}
	if c.Providers == nil {
		c.Providers = []map[string]any{}
	}
	if c.Defaults == nil {
		c.Defaults = map[string]any{}
	}
	// Inject api_key from env (env wins over JSON; JSON shouldn't have it).
	for _, p := range c.Providers {
		name, _ := p["name"].(string)
		envKey := ProviderEnvKeys[name]
		if envKey == "" {
			continue
		}
		if v := os.Getenv(envKey); v != "" {
			p["api_key"] = v
		}
	}
	return c, nil
}

// SaveConfig persists the config to disk via a temp-file + rename so a
// crash mid-write can't corrupt the file. api_key is stripped per
// provider — keys live in .env only.
func SaveConfig(path string, c Config) error {
	stripped := Config{
		Providers: make([]map[string]any, 0, len(c.Providers)),
		Defaults:  c.Defaults,
	}
	for _, p := range c.Providers {
		clone := make(map[string]any, len(p))
		for k, v := range p {
			if k == "api_key" {
				continue
			}
			clone[k] = v
		}
		stripped.Providers = append(stripped.Providers, clone)
	}
	data, err := json.MarshalIndent(stripped, "", "  ")
	if err != nil {
		return fmt.Errorf("state: marshal config: %w", err)
	}
	data = append(data, '\n')
	return atomicWrite(path, data, 0o644)
}

// atomicWrite writes data to path via a sibling temp file then renames.
// Callers depend on this for any state file that mustn't be corrupt
// after a crash mid-write (config.json, costs.json, etc.).
func atomicWrite(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp." + pidStr()
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return fmt.Errorf("state: write temp %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("state: rename %s -> %s: %w", tmp, path, err)
	}
	return nil
}

func pidStr() string { return fmt.Sprintf("%d", os.Getpid()) }

// WriteJSON is the public atomic-JSON-write helper, replacing the
// writeJsonSync / writeJsonAsync pair on the JS side.
func WriteJSON(path string, data any) error {
	buf, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("state: marshal: %w", err)
	}
	buf = append(buf, '\n')
	return atomicWrite(path, buf, 0o644)
}

// WriteEnvKey rewrites a single key in a .env file (creates if absent).
// Mirrors writeEnvKey in state.ts. Sets the value in os.Environ too so
// later os.Getenv calls see the new value.
func WriteEnvKey(envPath, name, value string) error {
	if name == "" {
		return errors.New("state: env name required")
	}
	var lines []string
	existing, err := os.ReadFile(envPath)
	if err == nil {
		// Strip a single trailing newline so we don't append a phantom blank.
		text := strings.TrimRight(string(existing), "\n")
		if text != "" {
			lines = strings.Split(text, "\n")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("state: read .env: %w", err)
	}

	prefix := name + "="
	newLine := name + "=" + value
	replaced := false
	for i, l := range lines {
		if strings.HasPrefix(l, prefix) {
			lines[i] = newLine
			replaced = true
			break
		}
	}
	if !replaced {
		lines = append(lines, newLine)
	}
	out := strings.Join(lines, "\n") + "\n"
	if err := atomicWrite(envPath, []byte(out), 0o600); err != nil {
		return err
	}
	_ = os.Setenv(name, value)
	return nil
}

// generateBridgeInternalKey produces the per-process key used by
// subprocesses (Claude binary, Task agents) to authenticate against
// /proxy/* — same shape as the TS side: "sk-bridge-" + 64 hex chars.
func generateBridgeInternalKey() string {
	buf := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		// Should never fail; if it does, the daemon shouldn't start.
		panic(fmt.Sprintf("state: crypto/rand failed: %v", err))
	}
	return "sk-bridge-" + hex.EncodeToString(buf)
}

// resolveBridgeInternalKey prefers the shared YHA_BRIDGE_KEY env var
// (set by yha.sh; mirrored by Node via process.env.YHA_BRIDGE_KEY) so
// cross-process /proxy/tool callbacks authenticate. Falls back to a
// freshly generated ephemeral key with a Warn log when the env is
// unset — useful for unit tests / CI, but end-to-end runs need the
// shared key.
func resolveBridgeInternalKey(log *logger.Logger) string {
	if v := os.Getenv("YHA_BRIDGE_KEY"); v != "" {
		return v
	}
	if log != nil {
		log.Warn(
			"YHA_BRIDGE_KEY not set in env — generated ephemeral key. " +
				"Cross-process /proxy/tool callbacks from Go core will fail with 401 " +
				"until both sides agree. Set YHA_BRIDGE_KEY in bridge/.env.",
		)
	}
	return generateBridgeInternalKey()
}

// ── Store ──────────────────────────────────────────────────────────────────

// Store owns the config + the immutable BRIDGE_INTERNAL_KEY. One Store
// per daemon process. Session-scoped maps (claudeSessions, chatHistory,
// activeStreams, activeProcesses) live in Node — adding them here ahead
// of an actual consumer in Go would just ship a misleading "Go owns
// runtime state" signal.
type Store struct {
	cfgMu   sync.RWMutex
	cfg     Config
	cfgPath string

	bridgeInternalKey string
}

// NewStore loads config from configPath (creates empty if missing) and
// resolves the BRIDGE_INTERNAL_KEY. The key is read from YHA_BRIDGE_KEY
// first (set by yha.sh so Node and Go agree); when unset a fallback
// key is generated and the supplied logger receives a Warn message.
// log may be nil — silent fallback is fine for unit tests.
func NewStore(configPath string, log *logger.Logger) (*Store, error) {
	cfg, err := LoadConfig(configPath)
	if err != nil {
		return nil, err
	}
	return &Store{
		cfg:               cfg,
		cfgPath:           configPath,
		bridgeInternalKey: resolveBridgeInternalKey(log),
	}, nil
}

// BridgeInternalKey returns the per-process key.
func (s *Store) BridgeInternalKey() string { return s.bridgeInternalKey }

// Config returns a deep copy. Mutate the returned value freely.
func (s *Store) Config() Config {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return cloneConfig(s.cfg)
}

// ModelPricing returns the per-1M-token input + output prices for
// modelName, looked up across all configured providers' `models`
// maps. Returns ok=false when the model id isn't priced. Mirrors
// Node's bridge/models/config.ts:getModelPricing.
func (s *Store) ModelPricing(modelName string) (priceInput, priceOutput float64, ok bool) {
	if modelName == "" {
		return 0, 0, false
	}
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	for _, p := range s.cfg.Providers {
		models, _ := p["models"].(map[string]any)
		if models == nil {
			continue
		}
		m, _ := models[modelName].(map[string]any)
		if m == nil {
			continue
		}
		pi := readFloat(m["price_input"])
		po := readFloat(m["price_output"])
		if pi > 0 || po > 0 {
			return pi, po, true
		}
	}
	return 0, 0, false
}

func readFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}

// ProviderEndpoint returns (endpoint, api_key, ok) for the provider
// whose `name` matches the supplied label. Used by the stream route
// to extend the direct-API path to configured third-party providers
// (DeepSeek, NVIDIA NIM, OpenRouter, Groq, …) so they stream
// token-by-token through Go's OpenAIProvider instead of being
// funneled through the buffering claude-binary detour. Returns
// ok=false when the provider is absent or doesn't have both fields
// configured.
func (s *Store) ProviderEndpoint(name string) (string, string, bool) {
	if name == "" {
		return "", "", false
	}
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	for _, p := range s.cfg.Providers {
		n, _ := p["name"].(string)
		if n != name {
			continue
		}
		endpoint, _ := p["endpoint"].(string)
		key, _ := p["api_key"].(string)
		if endpoint == "" || key == "" {
			return "", "", false
		}
		return endpoint, key, true
	}
	return "", "", false
}

// APIKey returns the api_key field for the provider whose name matches
// the supplied label (e.g. "Anthropic", "OpenAI", "Google"). Returns
// the empty string when no provider matches or the field is missing.
// Avoids the deep-clone Config() performs — the read lock is held only
// long enough to walk the providers slice and copy the string out.
func (s *Store) APIKey(name string) string {
	if name == "" {
		return ""
	}
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	for _, p := range s.cfg.Providers {
		n, _ := p["name"].(string)
		if n != name {
			continue
		}
		k, _ := p["api_key"].(string)
		return k
	}
	return ""
}

// SetConfig replaces the in-memory config and persists it. The api_key
// fields are stripped before disk write (preserves the env-only secret
// rule from the TS side).
func (s *Store) SetConfig(c Config) error {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	s.cfg = cloneConfig(c)
	return SaveConfig(s.cfgPath, s.cfg)
}

func cloneConfig(c Config) Config {
	out := Config{
		Providers: make([]map[string]any, 0, len(c.Providers)),
		Defaults:  cloneMap(c.Defaults),
	}
	for _, p := range c.Providers {
		out.Providers = append(out.Providers, cloneMap(p))
	}
	return out
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// ── Helpers used by the daemon main ────────────────────────────────────────

// ResolveConfigPath returns the canonical config.json location. If
// $YHA_CONFIG_PATH is set it wins, otherwise BRIDGE_ROOT/config.json.
func ResolveConfigPath(bridgeRoot string) string {
	if v := os.Getenv("YHA_CONFIG_PATH"); v != "" {
		abs, _ := filepath.Abs(v)
		return abs
	}
	return filepath.Join(bridgeRoot, "config.json")
}
