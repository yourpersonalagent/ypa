// Registry + state-file persistence for the MCP control plane.
//
// Mirrors bridge/modules/mcp-client/lib/state.ts. Two JSON files at
// BridgeRoot:
//
//   mcp-registry.json — the upstream-server catalogue. Source of truth
//     for which MCP servers YHA spawns. Shape:
//       {"mcpServers": {"<name>": {"command":..., "args":[...], "env":{...}}}}
//
//   mcp-state.json    — the run-state + sharing toggle. Shape:
//       {"running": ["name1", ...], "externalSharing": true}
//
// Both files are read with a try/catch-style fallback: missing or
// unparseable files return empty defaults so the daemon keeps booting.
// Both writes go through a temp + rename for crash safety.
package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// StateFile mirrors mcp-state.json. ExternalSharing defaults to true to
// match the JS load-side default ("data.externalSharing !== false").
type StateFile struct {
	Running         []string `json:"running"`
	ExternalSharing bool     `json:"externalSharing"`
}

// registryFile is the on-disk shape of mcp-registry.json. Top-level key
// is "mcpServers" — kept stable across the TS/Go split so user state
// transfers as-is.
type registryFile struct {
	MCPServers map[string]registryEntry `json:"mcpServers"`
}

type registryEntry struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env,omitempty"`
}

// LoadRegistry reads the registry file and returns a name → ServerConfig
// map. A missing file yields an empty map (same as the JS try/catch).
// A malformed file is a real error so callers can surface it.
func LoadRegistry(path string) (map[string]ServerConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]ServerConfig{}, nil
		}
		return nil, fmt.Errorf("mcp: read registry %s: %w", path, err)
	}
	var rf registryFile
	if err := json.Unmarshal(data, &rf); err != nil {
		return nil, fmt.Errorf("mcp: parse registry %s: %w", path, err)
	}
	out := make(map[string]ServerConfig, len(rf.MCPServers))
	for name, e := range rf.MCPServers {
		out[name] = ServerConfig{
			Name:    name,
			Command: e.Command,
			Args:    append([]string(nil), e.Args...),
			Env:     cloneStringMap(e.Env),
		}
	}
	return out, nil
}

// SaveRegistry writes the registry atomically (temp + rename). The Name
// field on each ServerConfig is dropped — it's the map key, not part of
// the on-disk entry.
func SaveRegistry(path string, registry map[string]ServerConfig) error {
	rf := registryFile{MCPServers: make(map[string]registryEntry, len(registry))}
	for name, cfg := range registry {
		args := append([]string(nil), cfg.Args...)
		if args == nil {
			args = []string{} // serialise as [] not null, mirror the JS writer
		}
		rf.MCPServers[name] = registryEntry{
			Command: cfg.Command,
			Args:    args,
			Env:     cloneStringMap(cfg.Env),
		}
	}
	return writeJSONAtomic(path, rf)
}

// LoadState reads mcp-state.json. A missing file yields the empty/on
// default (matches the JS loader). A malformed file is an error.
func LoadState(path string) (StateFile, error) {
	def := StateFile{Running: []string{}, ExternalSharing: true}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return def, nil
		}
		return def, fmt.Errorf("mcp: read state %s: %w", path, err)
	}
	// Use a peek-style decode so we can preserve "externalSharing
	// defaults to true unless explicitly false" (matches JS).
	var raw struct {
		Running         []string `json:"running"`
		ExternalSharing *bool    `json:"externalSharing"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return def, fmt.Errorf("mcp: parse state %s: %w", path, err)
	}
	out := StateFile{Running: raw.Running, ExternalSharing: true}
	if out.Running == nil {
		out.Running = []string{}
	}
	if raw.ExternalSharing != nil {
		out.ExternalSharing = *raw.ExternalSharing
	}
	return out, nil
}

// SaveState writes mcp-state.json atomically.
func SaveState(path string, state StateFile) error {
	if state.Running == nil {
		state.Running = []string{}
	}
	return writeJSONAtomic(path, state)
}

// ── helpers (private) ──────────────────────────────────────────────────────

// writeJSONAtomic mirrors internal/state.WriteJSON (temp + rename).
// Inlined here because we don't want internal/mcp to depend on
// internal/state for a one-line helper.
func writeJSONAtomic(path string, v any) error {
	buf, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("mcp: marshal: %w", err)
	}
	buf = append(buf, '\n')
	tmp := fmt.Sprintf("%s.tmp.%d", path, os.Getpid())
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return fmt.Errorf("mcp: write temp %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("mcp: rename %s -> %s: %w", tmp, path, err)
	}
	return nil
}

func cloneStringMap(m map[string]string) map[string]string {
	if m == nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
