package tui

import "testing"

// TestAdoptDefaultProvider verifies the SUB-first selection rule that
// keeps first-send-after-launch off the paid Anthropic API. The
// matching catalogue mirrors what /v1/models/ returns on a host with
// both a configured ANTHROPIC_API_KEY and one or more Claude Code
// subscription instances — three rows for the same model name.
func TestAdoptDefaultProvider(t *testing.T) {
	cat := []modelEntry{
		{Name: "claude-opus-4-7", Provider: "Anthropic API"},
		{Name: "claude-opus-4-7", Provider: "Anthropic-SUB"},
		{Name: "claude-opus-4-7", Provider: "Anthropic-SUB2"},
		{Name: "gpt-5", Provider: "OpenAI API"},
		{Name: "gpt-5", Provider: "OpenAI-SUB"},
	}

	cases := []struct {
		name         string
		activeModel  string
		preset       string // selectedProvider before the call
		wantProvider string
	}{
		{
			name:         "claude_picks_first_sub",
			activeModel:  "claude-opus-4-7",
			wantProvider: "Anthropic-SUB",
		},
		{
			name:         "openai_picks_first_sub",
			activeModel:  "gpt-5",
			wantProvider: "OpenAI-SUB",
		},
		{
			name:         "preset_wins_over_auto",
			activeModel:  "claude-opus-4-7",
			preset:       "Anthropic-SUB2",
			wantProvider: "Anthropic-SUB2",
		},
		{
			name:         "no_match_no_change",
			activeModel:  "made-up-model",
			wantProvider: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := chatModel{
				opts:             Options{Model: tc.activeModel},
				selectedProvider: tc.preset,
			}
			c.adoptDefaultProvider(cat)
			if got := c.activeProvider(); got != tc.wantProvider {
				t.Fatalf("provider = %q, want %q", got, tc.wantProvider)
			}
		})
	}
}

// TestAdoptDefaultProvider_FallbackToNonSub verifies that when no
// subscription instance is configured for a model we still pick *some*
// provider rather than leaving the field empty — that's the case where
// the user truly only has the paid API row, and sending the explicit
// hint at least makes the route deterministic.
func TestAdoptDefaultProvider_FallbackToNonSub(t *testing.T) {
	cat := []modelEntry{
		{Name: "claude-opus-4-7", Provider: "Anthropic API"},
	}
	c := chatModel{opts: Options{Model: "claude-opus-4-7"}}
	c.adoptDefaultProvider(cat)
	if got := c.activeProvider(); got != "Anthropic API" {
		t.Fatalf("provider = %q, want %q", got, "Anthropic API")
	}
}

// TestAdoptDefaultProvider_LateActiveModel covers the race where
// /v1/models/ arrives BEFORE the activeModelsMsg fixes the model id.
// chat.adoptDefaultProvider(nil) is re-invoked after the model id
// arrives — it must remember the catalogue from the earlier call.
func TestAdoptDefaultProvider_LateActiveModel(t *testing.T) {
	cat := []modelEntry{
		{Name: "claude-opus-4-7", Provider: "Anthropic-SUB"},
		{Name: "claude-opus-4-7", Provider: "Anthropic API"},
	}
	c := chatModel{opts: Options{}} // model id not yet known
	c.adoptDefaultProvider(cat)
	if c.activeProvider() != "" {
		t.Fatalf("expected empty provider before model id arrives, got %q", c.activeProvider())
	}
	c.opts.Model = "claude-opus-4-7"
	c.adoptDefaultProvider(nil) // catalogue should come from cache
	if got := c.activeProvider(); got != "Anthropic-SUB" {
		t.Fatalf("provider after late model id = %q, want %q", got, "Anthropic-SUB")
	}
}

func TestIsSubscriptionProviderName(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"Anthropic-SUB", true},
		{"Anthropic-SUB2", true},
		{"Anthropic-SUB17", true},
		{"OpenAI-SUB", true},
		{"OpenAI-SUB3", true},
		{"Anthropic API", false},
		{"Anthropic", false},
		{"OpenAI", false},
		{"Anthropic-SUBx", false},
		{"", false},
	}
	for _, tc := range tests {
		if got := isSubscriptionProviderName(tc.in); got != tc.want {
			t.Errorf("isSubscriptionProviderName(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
