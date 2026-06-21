package auth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *SessionStore {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "auth-sessions")
	store, err := NewSessionStore(dir, "shhh-secret", time.Minute)
	if err != nil {
		t.Fatalf("NewSessionStore: %v", err)
	}
	return store
}

func TestNewSessionStoreRequiresDirAndSecret(t *testing.T) {
	if _, err := NewSessionStore("", "x", 0); err == nil {
		t.Error("empty dir should fail")
	}
	if _, err := NewSessionStore(t.TempDir(), "", 0); err == nil {
		t.Error("empty secret should fail")
	}
}

func TestSessionRoundTrip(t *testing.T) {
	s := newTestStore(t)
	sess, err := s.Create("user_123", "alice@example.com", "Alice", true, "wsid_xyz")
	if err != nil {
		t.Fatal(err)
	}
	if len(sess.ID) != 64 {
		t.Errorf("ID length = %d, want 64", len(sess.ID))
	}
	got, err := s.Get(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Email != "alice@example.com" || got.UserID != "user_123" || !got.Allowed {
		t.Errorf("loaded session diverged: %+v", got)
	}
	if got.WorkOSSessionID != "wsid_xyz" {
		t.Errorf("WorkOS session id not preserved: %q", got.WorkOSSessionID)
	}
}

func TestSessionExpired(t *testing.T) {
	s := newTestStore(t)
	s.MaxAge = 10 * time.Millisecond
	sess, err := s.Create("u", "e@x", "n", true, "")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	got, err := s.Get(sess.ID)
	if err == nil {
		t.Errorf("expected expiry error, got %+v", got)
	}
	// Expired file should have been cleaned up.
	if _, err := os.Stat(filepath.Join(s.Dir, sess.ID+".json")); err == nil {
		t.Error("expired session file not cleaned")
	}
}

func TestSessionDelete(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.Create("u", "e", "n", true, "")
	if err := s.Delete(sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(sess.ID); err == nil {
		t.Error("expected ErrNotExist after delete")
	}
	// Deleting again is a no-op.
	if err := s.Delete(sess.ID); err != nil {
		t.Errorf("second delete failed: %v", err)
	}
}

func TestValidIDRejectsTraversal(t *testing.T) {
	cases := []string{
		"",
		"short",
		"../etc/passwd",
		"../../" + repeat64('a'),
		repeat64('z') + ".json", // too long
		string(make([]byte, 64)), // 64 zero bytes — hex chars only
	}
	for _, c := range cases {
		if validID(c) {
			t.Errorf("validID(%q) = true, expected false", c)
		}
	}
	if !validID(repeat64('a')) {
		t.Error("64 'a's should be valid")
	}
}

func TestIssueCookieRoundTrip(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.Create("u", "e", "n", true, "")

	cookie := s.IssueCookie(sess.ID, false)
	if cookie.Name != CookieName {
		t.Errorf("cookie name = %q, want %q", cookie.Name, CookieName)
	}
	if !cookie.HttpOnly {
		t.Error("cookie should be HttpOnly")
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("SameSite = %v, want Lax", cookie.SameSite)
	}

	// CookieLookup should resolve the cookie back to the right session.
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(cookie)
	lookup := s.CookieLookup()
	email, allowed, has := lookup(r)
	if !has || email != "e" || !allowed {
		t.Errorf("lookup got email=%q allowed=%v has=%v", email, allowed, has)
	}
}

func TestCookieLookupRejectsTamperedSignature(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.Create("u", "e", "n", true, "")
	cookie := s.IssueCookie(sess.ID, false)
	// Truncate the signature.
	cookie.Value = cookie.Value[:len(cookie.Value)-3]

	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(cookie)
	if _, _, has := s.CookieLookup()(r); has {
		t.Error("tampered cookie should not validate")
	}
}

func TestCookieLookupMissingCookie(t *testing.T) {
	s := newTestStore(t)
	r := httptest.NewRequest("GET", "/", nil)
	if _, _, has := s.CookieLookup()(r); has {
		t.Error("no cookie should produce hasSession=false")
	}
}

func TestClearCookieExpires(t *testing.T) {
	c := ClearCookie(false)
	if c.MaxAge >= 0 {
		t.Errorf("ClearCookie MaxAge = %d, want negative", c.MaxAge)
	}
}

// repeat64 builds a 64-char string of the given byte. Test helper.
func repeat64(c byte) string {
	out := make([]byte, 64)
	for i := range out {
		out[i] = c
	}
	return string(out)
}
