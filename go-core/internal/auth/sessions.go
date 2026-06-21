package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Phase 2d session store.
//
// Each authenticated user gets a Session record persisted at
// <dir>/<id>.json. The browser holds a signed cookie (yha.sid) carrying
// the session ID. On every protected request we HMAC-verify the cookie
// (cheap), look up the file, and return the associated user.
//
// Why files instead of a Map: survives daemon restarts. The Node bridge
// loses every session on restart because it uses express-session's
// MemoryStore; this is one of the small wins of the migration.

const (
	// CookieName is the Go-owned session cookie. Distinct from the
	// Node bridge's connect.sid so coexistence during cutover is safe.
	CookieName = "yha.sid"

	// DefaultSessionTTL matches the Node side's 7-day cookie maxAge.
	DefaultSessionTTL = 7 * 24 * time.Hour
)

// Session is one row of authenticated state. Persisted as JSON.
type Session struct {
	ID              string    `json:"id"`
	UserID          string    `json:"user_id"`
	Email           string    `json:"email"`
	Name            string    `json:"name"`
	Allowed         bool      `json:"allowed"`
	WorkOSSessionID string    `json:"workos_session_id,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	ExpiresAt       time.Time `json:"expires_at"`
}

// Expired reports whether the session has aged out.
func (s *Session) Expired() bool {
	return !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt)
}

// SessionStore is the file-backed store. Concurrent-safe via a small
// mutex on each path; reads and writes go through atomic temp+rename
// to avoid torn JSON on crash.
type SessionStore struct {
	Dir    string
	Secret string        // used to sign yha.sid; must be non-empty
	MaxAge time.Duration // session lifetime; defaults to DefaultSessionTTL

	mu sync.Mutex
}

// NewSessionStore creates the dir if missing and returns a store
// configured for cookie signing.
func NewSessionStore(dir, secret string, maxAge time.Duration) (*SessionStore, error) {
	if dir == "" {
		return nil, errors.New("auth: session store dir required")
	}
	if secret == "" {
		return nil, errors.New("auth: session secret required (set SESSION_SECRET)")
	}
	if maxAge <= 0 {
		maxAge = DefaultSessionTTL
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("auth: mkdir %s: %w", dir, err)
	}
	return &SessionStore{Dir: dir, Secret: secret, MaxAge: maxAge}, nil
}

// GenerateID returns a fresh 64-hex-char session ID. crypto/rand only.
func (s *SessionStore) GenerateID() string {
	buf := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		// crypto/rand should never fail on Linux; if it does the
		// daemon shouldn't be issuing sessions.
		panic(fmt.Sprintf("auth: crypto/rand: %v", err))
	}
	return hex.EncodeToString(buf)
}

// Create writes a new session record and returns it. ID is generated
// internally; callers store the returned ID in the cookie via
// IssueCookie.
func (s *SessionStore) Create(userID, email, name string, allowed bool, workosSID string) (*Session, error) {
	id := s.GenerateID()
	now := time.Now().UTC()
	sess := &Session{
		ID:              id,
		UserID:          userID,
		Email:           email,
		Name:            name,
		Allowed:         allowed,
		WorkOSSessionID: workosSID,
		CreatedAt:       now,
		ExpiresAt:       now.Add(s.MaxAge),
	}
	if err := s.write(sess); err != nil {
		return nil, err
	}
	return sess, nil
}

// Get loads a session by ID. Returns os.ErrNotExist when missing or
// expired (and the expired file is best-effort cleaned up).
func (s *SessionStore) Get(id string) (*Session, error) {
	if !validID(id) {
		return nil, os.ErrNotExist
	}
	path := s.pathFor(id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var sess Session
	if err := json.Unmarshal(data, &sess); err != nil {
		return nil, fmt.Errorf("auth: corrupt session %s: %w", id, err)
	}
	if sess.Expired() {
		_ = os.Remove(path)
		return nil, os.ErrNotExist
	}
	return &sess, nil
}

// Delete removes a session record. Idempotent — missing files are not
// an error.
func (s *SessionStore) Delete(id string) error {
	if !validID(id) {
		return nil
	}
	path := s.pathFor(id)
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *SessionStore) pathFor(id string) string {
	return filepath.Join(s.Dir, id+".json")
}

func (s *SessionStore) write(sess *Session) error {
	data, err := json.MarshalIndent(sess, "", "  ")
	if err != nil {
		return fmt.Errorf("auth: marshal session: %w", err)
	}
	data = append(data, '\n')
	tmp := s.pathFor(sess.ID) + ".tmp." + fmt.Sprintf("%d", os.Getpid())
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("auth: write temp %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, s.pathFor(sess.ID)); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("auth: rename: %w", err)
	}
	return nil
}

// validID guards against directory traversal: only hex chars, length 64.
func validID(id string) bool {
	if len(id) != 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// ── Cookie issuance / lookup ───────────────────────────────────────────────

// IssueCookie returns an *http.Cookie holding the signed session ID.
// Caller does w.Header() / w.SetCookie. Marks HttpOnly + SameSite=Lax;
// Secure flag flipped on by the caller when not using USE_HTTP=true.
func (s *SessionStore) IssueCookie(sessionID string, secure bool) *http.Cookie {
	value := EncodeExpressSessionCookie(sessionID, s.Secret)
	return &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(s.MaxAge.Seconds()),
	}
}

// ClearCookie returns a cookie that immediately expires the browser's
// yha.sid. Used on /auth/logout.
func ClearCookie(secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	}
}

// CookieLookup wraps the store as a SessionLookup for auth.Gate. It
// reads yha.sid, HMAC-verifies, looks up the file, and returns the
// user info. Replaces the Phase 2b /internal/whoami round-trip.
func (s *SessionStore) CookieLookup() SessionLookup {
	return func(r *http.Request) (string, bool, bool) {
		c, err := r.Cookie(CookieName)
		if err != nil || c.Value == "" {
			return "", false, false
		}
		id, ok := VerifyExpressSessionCookie(c.Value, s.Secret)
		if !ok {
			return "", false, false
		}
		sess, err := s.Get(id)
		if err != nil {
			return "", false, false
		}
		return sess.Email, sess.Allowed, true
	}
}

// LookupCookieSession returns the underlying Session (not just three
// scalars). Used by /v1/me which surfaces full user info.
func (s *SessionStore) LookupCookieSession(r *http.Request) (*Session, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return nil, false
	}
	id, ok := VerifyExpressSessionCookie(c.Value, s.Secret)
	if !ok {
		return nil, false
	}
	sess, err := s.Get(id)
	if err != nil {
		return nil, false
	}
	return sess, true
}

// CookieSessionID returns the session ID embedded in the cookie if it
// HMAC-verifies. Used by /auth/logout to find which file to delete.
func (s *SessionStore) CookieSessionID(r *http.Request) (string, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return "", false
	}
	id, ok := VerifyExpressSessionCookie(c.Value, s.Secret)
	if !ok {
		return "", false
	}
	if !strings.HasPrefix(id, "") || !validID(id) {
		return "", false
	}
	return id, true
}
