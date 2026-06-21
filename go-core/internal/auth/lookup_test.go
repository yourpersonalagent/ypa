package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newMockNode(t *testing.T, expectedKey string, response any, statusCode int) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/whoami", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if got := r.Header.Get("X-Yha-Internal-Key"); got != expectedKey {
			http.Error(w, "bad key", http.StatusForbidden)
			return
		}
		if got := r.Header.Get("Cookie"); !strings.Contains(got, "connect.sid=") {
			http.Error(w, "missing cookie", http.StatusBadRequest)
			return
		}
		w.WriteHeader(statusCode)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	})
	return httptest.NewServer(mux)
}

func TestLookupByCookieHappyPath(t *testing.T) {
	const sid = "real-session-id"
	cookie := EncodeExpressSessionCookie(sid, testSecret)
	srv := newMockNode(t, "key123", map[string]any{
		"hasSession": true,
		"email":      "alice@example.com",
		"allowed":    true,
		"name":       "Alice",
		"id":         "user_xxx",
	}, http.StatusOK)
	defer srv.Close()

	c := NewLookupClient(srv.URL, "key123", testSecret)
	got, err := c.LookupByCookie(context.Background(), cookie)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if !got.HasSession || got.Email != "alice@example.com" || !got.Allowed {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestLookupRejectsBadHMAC(t *testing.T) {
	srv := newMockNode(t, "key123", nil, http.StatusOK)
	defer srv.Close()
	c := NewLookupClient(srv.URL, "key123", testSecret)
	got, err := c.LookupByCookie(context.Background(), "s:bogus.xxxxxxxxxxxx")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if got.HasSession {
		t.Errorf("bad HMAC should produce HasSession=false, got %+v", got)
	}
}

func TestLookupCachesResult(t *testing.T) {
	const sid = "cached-id"
	cookie := EncodeExpressSessionCookie(sid, testSecret)
	calls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/whoami", func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hasSession": true, "email": "a@b", "allowed": true,
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := NewLookupClient(srv.URL, "k", testSecret)
	for i := 0; i < 5; i++ {
		_, err := c.LookupByCookie(context.Background(), cookie)
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if calls != 1 {
		t.Errorf("expected 1 upstream call after caching, got %d", calls)
	}
}

func TestLookupCacheExpires(t *testing.T) {
	const sid = "expiring-id"
	cookie := EncodeExpressSessionCookie(sid, testSecret)
	calls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/whoami", func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode(map[string]any{"hasSession": true})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := NewLookupClient(srv.URL, "k", testSecret)
	c.Cache = NewCache(20 * time.Millisecond)
	if _, err := c.LookupByCookie(context.Background(), cookie); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	if _, err := c.LookupByCookie(context.Background(), cookie); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Errorf("expected re-fetch after TTL, got %d calls", calls)
	}
}

func TestLookupErrorsWhenInternalKeyMissing(t *testing.T) {
	c := NewLookupClient("http://nope", "", testSecret)
	cookie := EncodeExpressSessionCookie("x", testSecret)
	_, err := c.LookupByCookie(context.Background(), cookie)
	if err == nil {
		t.Error("expected error when InternalKey empty")
	}
}

func TestLookupReturnsNoSessionForEmptyCookie(t *testing.T) {
	c := NewLookupClient("http://nope", "key", testSecret)
	got, err := c.LookupByCookie(context.Background(), "")
	if err != nil {
		t.Errorf("empty cookie should not error: %v", err)
	}
	if got.HasSession {
		t.Errorf("empty cookie should be no-session, got %+v", got)
	}
}

func TestHTTPLookupAdapter(t *testing.T) {
	const sid = "adapter-id"
	cookie := EncodeExpressSessionCookie(sid, testSecret)
	srv := newMockNode(t, "k", map[string]any{
		"hasSession": true, "email": "x@y", "allowed": false,
	}, http.StatusOK)
	defer srv.Close()
	c := NewLookupClient(srv.URL, "k", testSecret)
	lookup := c.HTTPLookup()

	r := httptest.NewRequest("GET", "/v1/sessions", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})

	email, allowed, has := lookup(r)
	if !has {
		t.Error("expected hasSession=true")
	}
	if email != "x@y" || allowed {
		t.Errorf("got email=%q allowed=%v", email, allowed)
	}
}
