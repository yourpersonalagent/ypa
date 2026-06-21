package auth

import (
	"sync"
	"time"
)

// whoamiCacheEntry pairs a result with its expiry instant.
type whoamiCacheEntry struct {
	value     WhoAmIResult
	expiresAt time.Time
}

// Cache is a fixed-TTL cache for WhoAmIResult keyed by session ID. Not
// LRU — stale entries simply stay until evicted on Get/Set. Sized for
// thousands of concurrent sessions, not millions.
type Cache struct {
	ttl     time.Duration
	mu      sync.Mutex
	entries map[string]whoamiCacheEntry
}

// NewCache creates a cache with the given TTL. ttl <= 0 disables caching
// (every Get returns miss).
func NewCache(ttl time.Duration) *Cache {
	return &Cache{ttl: ttl, entries: map[string]whoamiCacheEntry{}}
}

// Get returns a cached result if present and not expired.
func (c *Cache) Get(sessionID string) (WhoAmIResult, bool) {
	if c.ttl <= 0 {
		return WhoAmIResult{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[sessionID]
	if !ok {
		return WhoAmIResult{}, false
	}
	if time.Now().After(e.expiresAt) {
		delete(c.entries, sessionID)
		return WhoAmIResult{}, false
	}
	return e.value, true
}

// Set stores a result with a fresh TTL.
func (c *Cache) Set(sessionID string, v WhoAmIResult) {
	if c.ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[sessionID] = whoamiCacheEntry{
		value:     v,
		expiresAt: time.Now().Add(c.ttl),
	}
}

// Invalidate removes any cached entry for the given session ID.
// Phase 2b doesn't push invalidations from Node; the user accepts up
// to TTL of stale auth after logout. Phase 2d (full session migration)
// removes that gap entirely.
func (c *Cache) Invalidate(sessionID string) {
	c.mu.Lock()
	delete(c.entries, sessionID)
	c.mu.Unlock()
}
