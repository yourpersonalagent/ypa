package nodecallback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCostEventRecordPostsExpectedBody(t *testing.T) {
	var (
		gotMethod, gotKey, gotCT, gotPath atomic.Value
		gotBody                            atomic.Value
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod.Store(r.Method)
		gotKey.Store(r.Header.Get("x-bridge-key"))
		gotCT.Store(r.Header.Get("Content-Type"))
		gotPath.Store(r.URL.Path)
		body, _ := io.ReadAll(r.Body)
		gotBody.Store(string(body))
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	c := NewCostEventClient(srv.URL, "the-key", nil)
	err := c.Record(context.Background(), CostEventPayload{
		SessionID:           "sid-7",
		Model:               "claude-opus-4-7",
		Provider:            "Anthropic",
		InputTokens:         100,
		OutputTokens:        50,
		CacheReadTokens:     10,
		CacheCreationTokens: 5,
		ToolCallCount:       2,
		DurationMs:          1234,
	})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if gotMethod.Load() != "POST" {
		t.Errorf("method = %v, want POST", gotMethod.Load())
	}
	if gotPath.Load() != "/internal/cost-event" {
		t.Errorf("path = %v, want /internal/cost-event", gotPath.Load())
	}
	if gotKey.Load() != "the-key" {
		t.Errorf("auth header = %v, want the-key", gotKey.Load())
	}
	if ct, _ := gotCT.Load().(string); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}

	var sent map[string]any
	if err := json.Unmarshal([]byte(gotBody.Load().(string)), &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent["sessionId"] != "sid-7" {
		t.Errorf("body.sessionId = %v", sent["sessionId"])
	}
	if sent["model"] != "claude-opus-4-7" {
		t.Errorf("body.model = %v", sent["model"])
	}
	if sent["provider"] != "Anthropic" {
		t.Errorf("body.provider = %v", sent["provider"])
	}
	if sent["inputTokens"].(float64) != 100 {
		t.Errorf("body.inputTokens = %v", sent["inputTokens"])
	}
	if sent["outputTokens"].(float64) != 50 {
		t.Errorf("body.outputTokens = %v", sent["outputTokens"])
	}
	if sent["toolCallCount"].(float64) != 2 {
		t.Errorf("body.toolCallCount = %v", sent["toolCallCount"])
	}
	if sent["durationMs"].(float64) != 1234 {
		t.Errorf("body.durationMs = %v", sent["durationMs"])
	}
}

func TestCostEventRecordRequiresSessionAndModel(t *testing.T) {
	c := NewCostEventClient("http://example", "k", nil)
	if err := c.Record(context.Background(), CostEventPayload{Model: "x"}); err == nil {
		t.Error("expected err with empty SessionID")
	}
	if err := c.Record(context.Background(), CostEventPayload{SessionID: "x"}); err == nil {
		t.Error("expected err with empty Model")
	}
}

func TestCostEventRecordNon200ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"observability-plus disabled"}`, http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := NewCostEventClient(srv.URL, "k", nil)
	err := c.Record(context.Background(), CostEventPayload{
		SessionID: "sid", Model: "claude-opus-4-7",
	})
	if err == nil {
		t.Fatal("expected error on 503")
	}
	if !strings.Contains(err.Error(), "503") {
		t.Errorf("err should mention status: %v", err)
	}
}

func TestCostEventRecordNoNodeURL(t *testing.T) {
	c := NewCostEventClient("", "k", nil)
	err := c.Record(context.Background(), CostEventPayload{
		SessionID: "sid", Model: "claude-opus-4-7",
	})
	if err == nil {
		t.Error("expected error with empty NodeURL")
	}
}

func TestCostEventEnqueueAutoTitlePostsExpectedBody(t *testing.T) {
	var (
		gotKey, gotPath atomic.Value
		gotBody         atomic.Value
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath.Store(r.URL.Path)
		gotKey.Store(r.Header.Get("x-bridge-key"))
		body, _ := io.ReadAll(r.Body)
		gotBody.Store(string(body))
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	c := NewCostEventClient(srv.URL, "k", nil)
	if err := c.EnqueueAutoTitle(context.Background(), "sid-42"); err != nil {
		t.Fatalf("EnqueueAutoTitle: %v", err)
	}
	if gotPath.Load() != "/internal/auto-title" {
		t.Errorf("path = %v, want /internal/auto-title", gotPath.Load())
	}
	if gotKey.Load() != "k" {
		t.Errorf("auth header = %v, want k", gotKey.Load())
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(gotBody.Load().(string)), &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent["sessionId"] != "sid-42" {
		t.Errorf("body.sessionId = %v", sent["sessionId"])
	}
}

func TestCostEventEnqueueAutoTitleRequiresSession(t *testing.T) {
	c := NewCostEventClient("http://example", "k", nil)
	if err := c.EnqueueAutoTitle(context.Background(), ""); err == nil {
		t.Error("expected err on empty sessionID")
	}
}

func TestCostEventTimeoutGraceful(t *testing.T) {
	// Server intentionally hangs longer than the default 5s timeout —
	// we just verify the call returns with an error rather than blocking
	// the goroutine indefinitely. We use a synthetic short-timeout client
	// to avoid making the test slow.
	hold := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-hold // never released
	}))
	defer func() { close(hold); srv.Close() }()

	c := NewCostEventClient(srv.URL, "k", nil)
	c.httpClient = &http.Client{Timeout: 50 * time.Millisecond}

	start := time.Now()
	err := c.Record(context.Background(), CostEventPayload{
		SessionID: "sid", Model: "m",
	})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed > 2*time.Second {
		t.Errorf("Record took %v — should have timed out fast", elapsed)
	}
}

func TestCostEventFireAndForgetLogsError(t *testing.T) {
	var (
		called atomic.Int32
		wg     sync.WaitGroup
	)
	c := NewCostEventClient("http://example", "k", nil)
	wg.Add(1)
	c.FireAndForget("test", func(ctx context.Context) error {
		called.Add(1)
		wg.Done()
		return nil
	})
	wg.Wait()
	if called.Load() != 1 {
		t.Errorf("fn called %d times, want 1", called.Load())
	}
}
