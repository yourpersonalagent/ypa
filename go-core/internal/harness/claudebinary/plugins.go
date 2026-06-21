package claudebinary

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// LoadInstalledPluginDirs reads
// $HOME/.claude/plugins/installed_plugins.json (or the configDir
// equivalent when set) and returns every `installPath` listed under
// every entry of `plugins.<source>[]`. Empty when the file is
// missing / malformed. Mirrors Node's
// bridge/providers/core.ts:getInstalledPluginDirs.
//
// home is the home dir we should consult — usually the FE / harness
// adapter's resolved $HOME for the active subscription instance. ""
// falls back to os.Getenv("HOME").
func LoadInstalledPluginDirs(home string) []string {
	if home == "" {
		home = os.Getenv("HOME")
	}
	if home == "" {
		return nil
	}
	path := filepath.Join(home, ".claude", "plugins", "installed_plugins.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var probe struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil
	}
	var out []string
	for _, entries := range probe.Plugins {
		for _, e := range entries {
			if e.InstallPath != "" {
				out = append(out, e.InstallPath)
			}
		}
	}
	return out
}

// LoadAgentsJSON reads every $HOME/.claude/agents/*.md file, parses
// the YAML-frontmatter `name` + `description` and uses the body as
// the prompt, and returns the assembled map JSON-encoded — the wire
// shape the claude CLI's --agents flag expects. Empty string when the
// directory is missing or contains no valid markdown. Mirrors Node's
// bridge/providers/core.ts:loadAgentsJson with the same 30 s in-process
// cache so back-to-back chat turns don't re-read every file.
func LoadAgentsJSON(home string) string {
	if home == "" {
		home = os.Getenv("HOME")
	}
	if home == "" {
		return ""
	}
	agentsDir := filepath.Join(home, ".claude", "agents")
	cached := agentsCache.lookup(agentsDir)
	if cached != "" {
		return cached
	}
	entries, err := os.ReadDir(agentsDir)
	if err != nil {
		agentsCache.store(agentsDir, "")
		return ""
	}
	result := map[string]map[string]string{}
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(ent.Name()), ".md") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(agentsDir, ent.Name()))
		if err != nil {
			continue
		}
		m := frontmatterRe.FindSubmatch(body)
		if m == nil {
			continue
		}
		meta := parseFrontmatter(string(m[1]))
		name := meta["name"]
		if name == "" {
			name = strings.TrimSuffix(ent.Name(), ".md")
		}
		result[name] = map[string]string{
			"description": meta["description"],
			"prompt":      strings.TrimSpace(string(m[2])),
		}
	}
	if len(result) == 0 {
		agentsCache.store(agentsDir, "")
		return ""
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return ""
	}
	out := string(encoded)
	agentsCache.store(agentsDir, out)
	return out
}

var frontmatterRe = regexp.MustCompile(`(?s)^---\n(.*?)\n---\n(.*)$`)
var frontmatterLineRe = regexp.MustCompile(`^(\w+):\s*(.+)$`)

func parseFrontmatter(block string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(block, "\n") {
		m := frontmatterLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		out[strings.TrimSpace(m[1])] = strings.TrimSpace(m[2])
	}
	return out
}

// agentsCache stores the assembled JSON per agents directory for 30 s
// so back-to-back chat turns don't re-read every file. Mirrors
// AGENTS_CACHE_TTL in providers/core.ts.
type agentsCacheT struct {
	mu      sync.Mutex
	entries map[string]struct {
		value string
		at    time.Time
	}
}

func (a *agentsCacheT) lookup(key string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.entries == nil {
		return ""
	}
	v, ok := a.entries[key]
	if !ok {
		return ""
	}
	if time.Since(v.at) > 30*time.Second {
		delete(a.entries, key)
		return ""
	}
	return v.value
}

func (a *agentsCacheT) store(key, value string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.entries == nil {
		a.entries = map[string]struct {
			value string
			at    time.Time
		}{}
	}
	a.entries[key] = struct {
		value string
		at    time.Time
	}{value: value, at: time.Now()}
}

var agentsCache = &agentsCacheT{}
