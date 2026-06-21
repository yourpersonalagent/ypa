package internalapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// KeyRecord is the per-bearer-token record the api-keys.json store
// holds. Mirrors bridge/config/api-keys.ts:KeyRecord; only the fields
// the internal API actually reads are typed here — the rest stays in
// Node's structured cache.
type KeyRecord struct {
	ID         string `json:"id"`
	Label      string `json:"label,omitempty"`
	Hash       string `json:"hash"`
	Hint       string `json:"hint,omitempty"`
	CreatedAt  string `json:"createdAt,omitempty"`
	LastUsedAt string `json:"lastUsedAt,omitempty"`
}

// ExtractBearer pulls the bearer token from a request, accepting any
// of:
//
//	Authorization: Bearer yha_xyz
//	?api_key=yha_xyz   (query string)
//	{"api_key":"yha_xyz"}   (JSON body)
//
// The body fallback is only consulted for POSTs whose body we've
// pre-buffered (the caller is responsible for that — we don't drain
// the body here). Returns "" when no token is present.
func ExtractBearer(r *http.Request, prebufferedBody map[string]any) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(h, "Bearer ") {
			return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		}
	}
	if v := r.URL.Query().Get("api_key"); v != "" {
		return strings.TrimSpace(v)
	}
	if prebufferedBody != nil {
		if v, ok := prebufferedBody["api_key"].(string); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// HashToken computes the sha256(token) hex digest the api-keys.json
// store uses as its record key. Mirrors the JS:
// crypto.createHash('sha256').update(token).digest('hex').
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// FileVerifier loads + caches api-keys.json from bridgeRoot and
// resolves a bearer token by sha256 hash. Caches for cacheTTL so
// hot-paths don't disk-hit on every request, but a YHA admin who
// rotated keys via the FE sees the change after at most cacheTTL.
type FileVerifier struct {
	path     string
	cacheTTL time.Duration

	mu         sync.RWMutex
	records    map[string]KeyRecord // hash → record
	loadedAt   time.Time
	loadErrMsg string
}

// NewFileVerifier returns a verifier that reads bridge/api-keys.json
// relative to bridgeRoot. cacheTTL defaults to 30 s when zero or
// negative — matches the Node side's "almost real-time" expectation.
func NewFileVerifier(bridgeRoot string, cacheTTL time.Duration) *FileVerifier {
	if cacheTTL <= 0 {
		cacheTTL = 30 * time.Second
	}
	return &FileVerifier{
		path:     filepath.Join(bridgeRoot, "api-keys.json"),
		cacheTTL: cacheTTL,
	}
}

// Verify resolves a plain-text token to its KeyRecord. Returns nil
// when the token is empty, doesn't decode to a known hash, or when
// api-keys.json is unreadable.
func (v *FileVerifier) Verify(token string) *KeyRecord {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil
	}
	hash := HashToken(token)
	rec, _ := v.lookup(hash)
	return rec
}

func (v *FileVerifier) lookup(hash string) (*KeyRecord, error) {
	v.mu.RLock()
	if time.Since(v.loadedAt) < v.cacheTTL {
		if rec, ok := v.records[hash]; ok {
			r := rec
			v.mu.RUnlock()
			return &r, nil
		}
		v.mu.RUnlock()
		return nil, nil
	}
	v.mu.RUnlock()
	v.refresh()
	v.mu.RLock()
	defer v.mu.RUnlock()
	if rec, ok := v.records[hash]; ok {
		r := rec
		return &r, nil
	}
	return nil, nil
}

func (v *FileVerifier) refresh() {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.loadedAt = time.Now()
	data, err := os.ReadFile(v.path)
	if err != nil {
		v.loadErrMsg = err.Error()
		v.records = map[string]KeyRecord{}
		return
	}
	var raw []KeyRecord
	if err := json.Unmarshal(data, &raw); err != nil {
		v.loadErrMsg = "parse: " + err.Error()
		v.records = map[string]KeyRecord{}
		return
	}
	idx := make(map[string]KeyRecord, len(raw))
	for _, r := range raw {
		if r.Hash == "" {
			continue
		}
		idx[r.Hash] = r
	}
	v.loadErrMsg = ""
	v.records = idx
}
