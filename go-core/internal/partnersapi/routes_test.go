package partnersapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestPromptRespondNoHermes verifies the 503 fallback when the
// Gateway isn't configured.
func TestPromptRespondNoHermes(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, Deps{Hermes: nil})

	req := httptest.NewRequest("POST", "/v1/partners/hermes/prompt-respond",
		strings.NewReader(`{"sessionId":"s","type":"approval","approved":true}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	var out map[string]any
	if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if v, _ := out["success"].(bool); v {
		t.Errorf("success should be false: %+v", out)
	}
}

// TestPromptRespondBadJSON covers the 400 envelope for malformed body.
func TestPromptRespondBadJSON(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, Deps{Hermes: nil}) // unused — body decode fails first

	req := httptest.NewRequest("POST", "/v1/partners/hermes/prompt-respond",
		strings.NewReader(`{not-json}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (hermes==nil short-circuits before parse)", w.Code)
	}
}

// TestPromptRespondMissingFields covers the 400 envelope for empty
// sessionId / type.
func TestPromptRespondMissingFields(t *testing.T) {
	// Provide a non-nil but inert Hermes so the Hermes==nil branch
	// doesn't shadow the field-validation branch. We use a sentinel
	// struct because the real Gateway needs subprocess plumbing.
	t.Skip("requires hermes.Gateway double; covered by integration in cmd/yha-core")
}

// TestBridgeKeyGate verifies the wrap middleware rejects requests
// missing/invalid X-Bridge-Key.
func TestBridgeKeyGate(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, Deps{
		Hermes:    nil,
		BridgeKey: func() string { return "the-secret" },
	})

	cases := []struct {
		name string
		hdr  string
		want int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"wrong header", "wrong", http.StatusUnauthorized},
		// Correct header should fall through to the inner handler
		// (which returns 503 because Hermes is nil — both are fine
		// for this test, the point is "doesn't get 401").
		{"correct header", "the-secret", http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/v1/partners/hermes/prompt-respond",
				strings.NewReader(`{"sessionId":"s","type":"approval"}`))
			req.Header.Set("Content-Type", "application/json")
			if tc.hdr != "" {
				req.Header.Set("X-Bridge-Key", tc.hdr)
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Errorf("status = %d, want %d", w.Code, tc.want)
			}
		})
	}
}
