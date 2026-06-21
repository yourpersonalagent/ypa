// Small string / path / env / model-id utility helpers.
// Extracted verbatim from main.go (same package main) — see main.go.

package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/yha/core/internal/logger"
)

func stringDefault(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, _ := m[key].(string)
	return strings.TrimSpace(v)
}

func stringMapValue(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, _ := m[key].(string)
	return strings.TrimSpace(v)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func expandHomePath(in string) string {
	in = strings.TrimSpace(in)
	if in == "" {
		return ""
	}
	home, homeErr := os.UserHomeDir()
	if in == "~" {
		if homeErr == nil {
			return home
		}
		return in
	}
	if strings.HasPrefix(in, "~/") {
		if homeErr != nil || home == "" {
			return in
		}
		return filepath.Join(home, strings.TrimPrefix(in, "~/"))
	}
	// Config copied from another machine often keeps the Linux template
	// prefix /home/user (bridge/config/paths.ts catastrophic fallback).
	// Rewrite it to this host's real homedir so harness OAuth dirs resolve.
	if homeErr == nil && home != "" && (in == "/home/user" || strings.HasPrefix(in, "/home/user/")) {
		rest := strings.TrimPrefix(in, "/home/user")
		rest = strings.TrimPrefix(rest, "/")
		if rest == "" {
			return home
		}
		return filepath.Join(home, rest)
	}
	return in
}

// isClaudeModelID reports whether the model id is an Anthropic-native
// Claude model. Anything else is treated as a "non-Claude" model that
// the claude binary should reach via the bridge's /proxy/:model
// translator (External=true on SpawnOpts). Matches the prefixes
// pickProvider already uses for Anthropic.
func isClaudeModelID(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(m, "claude-") || strings.HasPrefix(m, "claude/") ||
		m == "sonnet" || m == "opus" || m == "haiku"
}

// resolveClaudeSubscriptionModel maps legacy rolling aliases (sonnet /
// opus / haiku) to full Claude API ids. The Claude Code CLI accepts the
// aliases interactively, but the upstream API rejects bare names like
// "opus" with HTTP 400.
func resolveClaudeSubscriptionModel(model string) string {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "sonnet":
		return "claude-sonnet-4-6"
	case "opus":
		return "claude-opus-4-6"
	case "haiku":
		return "claude-haiku-4-5"
	default:
		return strings.TrimSpace(model)
	}
}

func isClaudeSubscriptionProvider(provider string) bool {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return false
	}
	if provider == "Anthropic Subscription" {
		return true
	}
	if provider == "Anthropic" || provider == "Anthropic API" {
		return false
	}
	return strings.HasPrefix(provider, "Anthropic-SUB")
}

func isOpenAISubscriptionProvider(provider string) bool {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return false
	}
	if provider == "OpenAI Subscription" {
		return true
	}
	if provider == "OpenAI" || provider == "OpenAI API" {
		return false
	}
	return strings.HasPrefix(provider, "OpenAI-SUB")
}

func numAsInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n > 0 {
			return int(n), true
		}
	case int:
		if n > 0 {
			return n, true
		}
	}
	return 0, false
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// resolveDefaultCWD returns the daemon-wide fallback working directory
// used by stream.RouteDeps.DefaultCWD. The chat working-directory
// system must always have a non-empty value so the harness spawn can
// chdir explicitly instead of inheriting the daemon process's own cwd
// (which silently retargets every session to wherever yha-core happens
// to be running from).
//
// Resolution order:
//  1. $YHA_DEFAULT_CWD when it points at an existing directory.
//  2. $HOME.
//  3. "/" as the last-resort guarantee of non-empty.
//
// os.Getwd() is deliberately NOT a candidate: the daemon's own cwd is
// the silent-fallback this helper exists to prevent. If nothing else
// resolves, "/" is loudly wrong rather than quietly wrong-but-plausible.
func resolveDefaultCWD(log *logger.Logger) string {
	check := func(path string) bool {
		if strings.TrimSpace(path) == "" {
			return false
		}
		info, err := os.Stat(path)
		return err == nil && info.IsDir()
	}
	if v := strings.TrimSpace(os.Getenv("YHA_DEFAULT_CWD")); v != "" {
		if check(v) {
			if log != nil {
				log.Info("default-cwd.resolved", "source", "YHA_DEFAULT_CWD", "path", v)
			}
			return v
		}
		if log != nil {
			log.Warn("default-cwd.env-missing", "path", v)
		}
	}
	if home := strings.TrimSpace(os.Getenv("HOME")); home != "" && check(home) {
		if log != nil {
			log.Info("default-cwd.resolved", "source", "HOME", "path", home)
		}
		return home
	}
	// Windows: HOME is typically unset; use os.UserHomeDir() which resolves
	// USERPROFILE (or HOMEDRIVE+HOMEPATH). Without this fallback, the "/"
	// safety net below makes child-process spawns fail with
	// "The system cannot find the path specified" because Windows can't
	// use "/" as a working directory.
	if h, err := os.UserHomeDir(); err == nil && check(h) {
		if log != nil {
			log.Info("default-cwd.resolved", "source", "UserHomeDir", "path", h)
		}
		return h
	}
	if log != nil {
		log.Warn("default-cwd.fallback-root",
			"hint", "set $YHA_DEFAULT_CWD, $HOME, or $USERPROFILE to silence this; '/' is the safety net so the harness never inherits the daemon's own cwd")
	}
	return "/"
}
