package main

import "testing"

func TestIsClaudeModelIDIncludesRollingAliases(t *testing.T) {
	for _, model := range []string{"sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude/custom"} {
		if !isClaudeModelID(model) {
			t.Errorf("expected %q to be treated as a Claude model", model)
		}
	}
	if isClaudeModelID("gpt-5") {
		t.Error("gpt-5 must not be treated as a Claude model")
	}
}

func TestResolveClaudeSubscriptionModel(t *testing.T) {
	cases := map[string]string{
		"opus":   "claude-opus-4-6",
		"sonnet": "claude-sonnet-4-6",
		"haiku":  "claude-haiku-4-5",
		"claude-opus-4-7": "claude-opus-4-7",
	}
	for in, want := range cases {
		if got := resolveClaudeSubscriptionModel(in); got != want {
			t.Errorf("resolveClaudeSubscriptionModel(%q) = %q, want %q", in, got, want)
		}
	}
}
