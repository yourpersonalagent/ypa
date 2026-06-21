package nodecallback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPersistBroadcastMessagePostsExpectedBody(t *testing.T) {
	var (
		gotMethod, gotKey, gotCT, gotPath atomic.Value
		gotBody                           atomic.Value
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod.Store(r.Method)
		gotKey.Store(r.Header.Get("x-bridge-key"))
		gotCT.Store(r.Header.Get("Content-Type"))
		gotPath.Store(r.URL.Path)
		body, _ := io.ReadAll(r.Body)
		gotBody.Store(string(body))
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "ok": true})
	}))
	defer srv.Close()

	c := NewPersistBroadcastMessageClient(srv.URL, "the-key", nil)
	err := c.Persist(context.Background(), PersistBroadcastMessagePayload{
		SessionID:    "sid-bc",
		EmployeeID:   "emp-1",
		Text:         "hello from alice",
		Model:        "claude-opus-4-7",
		Role:         "assistant",
		InputTokens:  100,
		OutputTokens: 50,
		StopReason:   "end_turn",
		Author: &PersistBroadcastAuthor{
			ID:          "emp-1",
			Name:        "Alice",
			Role:        "Engineer",
			SymbolColor: "#ff00aa",
		},
	})
	if err != nil {
		t.Fatalf("Persist: %v", err)
	}
	if gotMethod.Load() != "POST" {
		t.Errorf("method = %v, want POST", gotMethod.Load())
	}
	if gotPath.Load() != "/internal/persist-broadcast-message" {
		t.Errorf("path = %v", gotPath.Load())
	}
	if gotKey.Load() != "the-key" {
		t.Errorf("bridge key = %v", gotKey.Load())
	}
	if ct, _ := gotCT.Load().(string); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(gotBody.Load().(string)), &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent["sessionId"] != "sid-bc" {
		t.Errorf("sessionId = %v", sent["sessionId"])
	}
	if sent["employeeId"] != "emp-1" {
		t.Errorf("employeeId = %v", sent["employeeId"])
	}
	if sent["text"] != "hello from alice" {
		t.Errorf("text = %v", sent["text"])
	}
	if sent["model"] != "claude-opus-4-7" {
		t.Errorf("model = %v", sent["model"])
	}
	if sent["inputTokens"].(float64) != 100 {
		t.Errorf("inputTokens = %v", sent["inputTokens"])
	}
	if sent["outputTokens"].(float64) != 50 {
		t.Errorf("outputTokens = %v", sent["outputTokens"])
	}
	author, ok := sent["author"].(map[string]any)
	if !ok {
		t.Fatalf("author block missing: %v", sent["author"])
	}
	if author["id"] != "emp-1" || author["name"] != "Alice" || author["role"] != "Engineer" || author["symbolColor"] != "#ff00aa" {
		t.Errorf("author block = %+v", author)
	}
}

func TestPersistBroadcastMessageRequiresSession(t *testing.T) {
	c := NewPersistBroadcastMessageClient("http://example", "k", nil)
	if err := c.Persist(context.Background(), PersistBroadcastMessagePayload{}); err == nil {
		t.Error("expected err with empty SessionID")
	}
}

func TestPersistBroadcastMessageNoNodeURL(t *testing.T) {
	c := NewPersistBroadcastMessageClient("", "k", nil)
	if err := c.Persist(context.Background(), PersistBroadcastMessagePayload{SessionID: "sid"}); err == nil {
		t.Error("expected err with empty NodeURL")
	}
}

func TestPersistBroadcastMessageNon2xxReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"sessions persistence unavailable"}`, http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	c := NewPersistBroadcastMessageClient(srv.URL, "k", nil)
	err := c.Persist(context.Background(), PersistBroadcastMessagePayload{
		SessionID: "sid", Text: "t",
	})
	if err == nil {
		t.Fatal("expected error on 503")
	}
	if !strings.Contains(err.Error(), "503") {
		t.Errorf("err should mention status: %v", err)
	}
}

func TestPersistBroadcastMessageTimeoutGraceful(t *testing.T) {
	hold := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-hold
	}))
	defer func() { close(hold); srv.Close() }()

	c := NewPersistBroadcastMessageClient(srv.URL, "k", nil)
	c.httpClient = &http.Client{Timeout: 50 * time.Millisecond}

	start := time.Now()
	err := c.Persist(context.Background(), PersistBroadcastMessagePayload{
		SessionID: "sid", Text: "t",
	})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed > 2*time.Second {
		t.Errorf("Persist took %v — should have timed out fast", elapsed)
	}
}

func TestFinalizeAbandonedPostsSessionAndReason(t *testing.T) {
	var gotPath, gotKey, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-bridge-key")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewPersistBroadcastMessageClient(srv.URL, "bridge-secret", nil)
	if err := c.FinalizeAbandoned(context.Background(), "sid-stuck", "stopped"); err != nil {
		t.Fatalf("FinalizeAbandoned: %v", err)
	}
	if gotPath != "/internal/finalize-abandoned-live" {
		t.Fatalf("path=%q", gotPath)
	}
	if gotKey != "bridge-secret" {
		t.Fatalf("bridge key=%q", gotKey)
	}
	var sent map[string]string
	if err := json.Unmarshal([]byte(gotBody), &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent["sessionId"] != "sid-stuck" || sent["reason"] != "stopped" {
		t.Fatalf("body=%v", sent)
	}
}
