package nodecallback

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yha/core/internal/tools"
)

func TestClientGetSendsAuthHeader(t *testing.T) {
	var gotKey atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey.Store(r.Header.Get("x-bridge-key"))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tools": []tools.Tool{{Name: "AskUser", Source: "node:bridge-tools"}},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "secret-key", nil)
	out, err := c.Get(context.Background())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(out) != 1 || out[0].Name != "AskUser" {
		t.Errorf("tools = %+v", out)
	}
	if got := gotKey.Load(); got != "secret-key" {
		t.Errorf("x-bridge-key sent = %v, want secret-key", got)
	}
}

func TestClientCachesWithinTTL(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tools": []tools.Tool{{Name: "Cached"}},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k", nil)
	c.SetTTL(time.Hour) // make sure the cache wins
	for i := 0; i < 3; i++ {
		out, err := c.Get(context.Background())
		if err != nil {
			t.Fatalf("Get %d: %v", i, err)
		}
		if len(out) != 1 {
			t.Errorf("Get %d returned %d tools", i, len(out))
		}
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("upstream hits = %d, want 1 (cache should suppress 2&3)", got)
	}
}

func TestClientInvalidateForcesRefetch(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tools": []tools.Tool{{Name: "Cached"}},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k", nil)
	c.SetTTL(time.Hour)
	if _, err := c.Get(context.Background()); err != nil {
		t.Fatalf("Get 1: %v", err)
	}
	c.Invalidate()
	if _, err := c.Get(context.Background()); err != nil {
		t.Fatalf("Get 2: %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Errorf("hits = %d, want 2 (invalidate should force refetch)", got)
	}
}

func TestClientReturnsCachedOnError(t *testing.T) {
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tools": []tools.Tool{{Name: "Cached"}},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k", nil)
	c.SetTTL(time.Millisecond) // expire immediately so the second Get re-fetches
	if _, err := c.Get(context.Background()); err != nil {
		t.Fatalf("first Get: %v", err)
	}
	time.Sleep(2 * time.Millisecond)

	fail.Store(true)
	out, err := c.Get(context.Background())
	if err != nil {
		t.Fatalf("Get during outage should swallow err and return cached, got: %v", err)
	}
	if len(out) != 1 || out[0].Name != "Cached" {
		t.Errorf("expected cached tools on outage, got %+v", out)
	}
}

func TestClientFirstFailReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k", nil)
	if _, err := c.Get(context.Background()); err == nil {
		t.Error("expected error when no cache and upstream is down")
	}
}

func TestClientNoNodeURL(t *testing.T) {
	c := NewClient("", "k", nil)
	if _, err := c.Get(context.Background()); err == nil {
		t.Error("expected error with empty NodeURL")
	}
}
