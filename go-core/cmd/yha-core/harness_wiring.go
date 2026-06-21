// Harness instance tables + history resolvers + instance-from-config builders.
// Extracted verbatim from main.go (same package main) — see main.go.

package main

import (
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/harness/claudebinary"
	codexh "github.com/yha/core/internal/harness/codex"
	grokbuildh "github.com/yha/core/internal/harness/grokbuild"
	"github.com/yha/core/internal/state"
)

type harnessInstance struct {
	Label     string
	ConfigDir string
	Bin       string
}

type harnessInstances []harnessInstance

func (h harnessInstances) pick(label string) harnessInstance {
	if len(h) == 0 {
		return harnessInstance{}
	}
	selected := strings.TrimSpace(label)
	if selected == "" {
		return h[0]
	}
	for _, inst := range h {
		if inst.Label == selected {
			return inst
		}
	}
	return harnessInstance{}
}

// pickBySubProvider resolves an instance by the SUB index encoded in a
// subscription provider name. "Anthropic-SUB" / "OpenAI-SUB" → idx 0;
// "Anthropic-SUB2" / "OpenAI-SUB3" → idx 1 / 2 etc. The synthetic
// "Anthropic Subscription" / "OpenAI Subscription" aliases also map to
// idx 0 (legacy first-instance behaviour). Returns the matched
// instance + true, or zero + false when the provider doesn't carry a
// subscription hint or the index is out of range. Mirrors
// bridge/providers/core.ts: resolveSubscriptionProvider.
func (h harnessInstances) pickBySubProvider(provider string) (harnessInstance, bool) {
	p := strings.TrimSpace(provider)
	if p == "" || len(h) == 0 {
		return harnessInstance{}, false
	}
	idx := -1
	if m := reAnthropicSub.FindStringSubmatch(p); m != nil {
		if m[1] == "" {
			idx = 0
		} else if n, err := strconv.Atoi(m[1]); err == nil && n >= 1 {
			idx = n - 1
		}
	} else if p == "Anthropic Subscription" {
		idx = 0
	}
	if idx < 0 {
		if m := reOpenAISub.FindStringSubmatch(p); m != nil {
			if m[1] == "" {
				idx = 0
			} else if n, err := strconv.Atoi(m[1]); err == nil && n >= 1 {
				idx = n - 1
			}
		} else if p == "OpenAI Subscription" {
			idx = 0
		}
	}
	if idx < 0 {
		if m := reGrokSub.FindStringSubmatch(p); m != nil {
			if m[1] == "" {
				idx = 0
			} else if n, err := strconv.Atoi(m[1]); err == nil && n >= 1 {
				idx = n - 1
			}
		} else if p == "Grok Subscription" {
			idx = 0
		}
	}
	if idx < 0 || idx >= len(h) {
		return harnessInstance{}, false
	}
	return h[idx], true
}

var (
	reAnthropicSub = regexp.MustCompile(`^Anthropic-SUB(\d*)$`)
	reOpenAISub    = regexp.MustCompile(`^OpenAI-SUB(\d*)$`)
	reGrokSub      = regexp.MustCompile(`^Grok-SUB(\d*)$`)
)

type claudeHistoryResolver struct {
	history *harness.History
}

func (r claudeHistoryResolver) Get(historySessionID string) string {
	if r.history == nil {
		return ""
	}
	v, _ := r.history.Get(claudebinary.HarnessID, historySessionID)
	return v
}

func (r claudeHistoryResolver) Set(historySessionID, claudeSessionID string) {
	if r.history == nil {
		return
	}
	_ = r.history.Set(claudebinary.HarnessID, historySessionID, claudeSessionID)
}

func (r claudeHistoryResolver) Delete(historySessionID string) {
	if r.history == nil {
		return
	}
	_ = r.history.Delete(claudebinary.HarnessID, historySessionID)
}

type openclawHistoryResolver struct {
	history *harness.History
}

func (r openclawHistoryResolver) Get(harnessID, key string) string {
	if r.history == nil {
		return ""
	}
	v, _ := r.history.Get(harnessID, key)
	return v
}

func (r openclawHistoryResolver) Set(harnessID, key, value string) {
	if r.history == nil {
		return
	}
	_ = r.history.Set(harnessID, key, value)
}

// grokHistoryResolver adapts the central harness.History for the grok
// harness (keyed under grokbuild.HarnessID = "grok"). Used by the
// adapter in main.go to implement --resume + conditional fold parity
// with claude-binary (see claudeHistoryResolver for the pattern).
type grokHistoryResolver struct {
	history *harness.History
}

func (r grokHistoryResolver) Get(yhaSID string) string {
	if r.history == nil {
		return ""
	}
	v, _ := r.history.Get(grokbuildh.HarnessID, yhaSID)
	return v
}

func (r grokHistoryResolver) Set(yhaSID, grokSID string) {
	if r.history == nil {
		return
	}
	_ = r.history.Set(grokbuildh.HarnessID, yhaSID, grokSID)
}

func (r grokHistoryResolver) Delete(yhaSID string) {
	if r.history == nil {
		return
	}
	_ = r.history.Delete(grokbuildh.HarnessID, yhaSID)
}

func cfgDefaultsMap(store *state.Store) map[string]any {
	if store == nil {
		return nil
	}
	return store.Config().Defaults
}

func instanceDefaultsFromConfig(defaults map[string]any, key, binKey string) harnessInstances {
	raw, _ := defaults[key].([]any)
	if len(raw) == 0 {
		if typed, ok := defaults[key].([]map[string]any); ok {
			for _, item := range typed {
				raw = append(raw, item)
			}
		}
	}
	out := make(harnessInstances, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		label, _ := m["label"].(string)
		configDir, _ := m["configDir"].(string)
		bin, _ := m[binKey].(string)
		out = append(out, harnessInstance{
			Label:     label,
			ConfigDir: configDir,
			Bin:       bin,
		})
	}
	return out
}

func newCodexInstanceResolver(instances harnessInstances) codexh.InstanceResolver {
	if len(instances) == 0 {
		return nil
	}
	r := codexh.NewMemoryInstanceResolver()
	for _, inst := range instances {
		if inst.Label == "" || inst.ConfigDir == "" {
			continue
		}
		r.Set(inst.Label, expandHomePath(inst.ConfigDir))
	}
	return r
}

func newGrokInstanceResolver(instances harnessInstances) grokbuildh.InstanceResolver {
	if len(instances) == 0 {
		return nil
	}
	r := grokbuildh.NewMemoryInstanceResolver()
	for _, inst := range instances {
		if inst.Label == "" || inst.ConfigDir == "" {
			continue
		}
		r.Set(inst.Label, normalizeGrokHomeDir(expandHomePath(inst.ConfigDir)))
	}
	return r
}

// normalizeGrokHomeDir converts the UI/account "config dir" convention into
// the HOME/USERPROFILE that the Grok CLI expects. Current xAI docs specify the
// user-level config at ~/.grok/config.toml (%USERPROFILE%\.grok\config.toml on
// Windows), and the CLI stores auth relative to the profile home. Older YPA
// configs often stored the account dir itself as .../.grok; if we pass that as
// HOME, Grok looks under .../.grok/.grok, misses the OAuth cache, and silently
// waits for device login in headless mode. Treat a trailing .grok as "profile
// home is the parent" while still allowing explicit per-account homes.
func normalizeGrokHomeDir(dir string) string {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return ""
	}
	clean := filepath.Clean(dir)
	if strings.EqualFold(filepath.Base(clean), ".grok") {
		parent := filepath.Dir(clean)
		if parent != "." && parent != clean {
			return parent
		}
	}
	return dir
}
