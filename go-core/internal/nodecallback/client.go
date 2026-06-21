// Package nodecallback owns the two HTTP surfaces Go uses to talk back
// into the Node bridge for module-tool support:
//
//   - CatalogClient — GET <NodeURL>/internal/tool-catalog returns the
//     full module-provided tool list, used by the composite runner to
//     learn which non-builtin / non-pool tools Node owns.
//   - Runner — POST <NodeURL>/proxy/tool {name, input, cwd, sessionId}
//     invokes a Node-side tool and returns the *tools.Result. Used by
//     the composite runner when a tool name dispatches to a Node module.
//
// Both surfaces authenticate with the x-bridge-key header. The key is
// supplied by the caller at construction time (typically
// state.Store.BridgeInternalKey()).
//
// CatalogClient caches the most recent successful catalog in memory.
// Cache TTL is 30 s; Invalidate() forces a refresh on the next Get.
// On a non-200 response the previous cached value is returned along
// with a logged warning so a brief Node outage doesn't blank the Go
// catalog mid-stream.
package nodecallback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/tools"
)

// defaultCacheTTL bounds how long Get returns a cached catalog without
// touching the network. 30 s matches the cadence Node module hot-reload
// expects — long enough to be useful, short enough that a manually
// enabled module shows up within one chat turn.
const defaultCacheTTL = 30 * time.Second

// defaultRequestTimeout caps the Node round-trip. If the bridge is
// processing a 30 s eager-load on cold boot the catalog refresh
// shouldn't pin the chat loop indefinitely; falling back to the cached
// snapshot is fine.
const defaultRequestTimeout = 5 * time.Second

// Client fetches the module-provided tool catalog from a running Node
// bridge. Construct via NewClient; the zero value is not useful.
//
// Safe for concurrent use. The internal cache uses an RWMutex so
// concurrent Get() readers don't serialise.
type Client struct {
	nodeURL    string
	bridgeKey  string
	log        *logger.Logger
	httpClient *http.Client
	ttl        time.Duration

	mu       sync.RWMutex
	cache    []tools.Tool
	cachedAt time.Time
}

// NewClient returns a Client that talks to nodeURL with the supplied
// bridge key. nodeURL should be the bare base (no trailing slash);
// passing http://127.0.0.1:8442 is typical. A nil logger is replaced
// with a no-op writer so the daemon stays quiet in tests.
func NewClient(nodeURL, bridgeKey string, log *logger.Logger) *Client {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &Client{
		nodeURL:   strings.TrimRight(nodeURL, "/"),
		bridgeKey: bridgeKey,
		log:       log,
		httpClient: &http.Client{
			Timeout: defaultRequestTimeout,
		},
		ttl: defaultCacheTTL,
	}
}

// SetTTL overrides the cache duration. Useful for tests that want to
// observe a refresh deterministically.
func (c *Client) SetTTL(d time.Duration) {
	if d <= 0 {
		return
	}
	c.ttl = d
}

// Get returns the current module-provided tool catalog. Behaviour:
//
//   - If the cache is fresh (within ttl), return it without a request.
//   - Otherwise GET /internal/tool-catalog with the bridge key.
//   - On non-200 / transport error: return the previous cached slice
//     and log a warning. nil cached value is only returned when the
//     daemon has never successfully fetched a catalog.
//
// The returned slice is shared with the cache — callers should treat
// it as read-only (append-safe but mutating individual Tool fields
// would race with the next refresh).
func (c *Client) Get(ctx context.Context) ([]tools.Tool, error) {
	c.mu.RLock()
	cached := c.cache
	cachedAt := c.cachedAt
	c.mu.RUnlock()

	if !cachedAt.IsZero() && time.Since(cachedAt) < c.ttl {
		return cached, nil
	}

	fresh, err := c.fetch(ctx)
	if err != nil {
		if cached != nil {
			c.log.Warn("nodecallback.catalog.degraded",
				"err", err, "cached_entries", len(cached))
			return cached, nil
		}
		return nil, err
	}

	c.mu.Lock()
	c.cache = fresh
	c.cachedAt = time.Now()
	c.mu.Unlock()
	return fresh, nil
}

// Invalidate clears the cached snapshot so the next Get re-fetches.
// Called by the composite runner when a dispatch lookup fails (the
// model asked for a tool name we don't know — maybe Node enabled a
// new module since our last refresh).
func (c *Client) Invalidate() {
	c.mu.Lock()
	c.cachedAt = time.Time{}
	c.mu.Unlock()
}

// fetch performs the actual HTTP GET. Separated out so Get can keep
// its cache logic terse.
func (c *Client) fetch(ctx context.Context) ([]tools.Tool, error) {
	if c.nodeURL == "" {
		return nil, errors.New("nodecallback: no NodeURL configured")
	}
	url := c.nodeURL + "/internal/tool-catalog"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("nodecallback: build request: %w", err)
	}
	if c.bridgeKey != "" {
		req.Header.Set("x-bridge-key", c.bridgeKey)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("nodecallback: GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("nodecallback: %s returned %d: %s",
			url, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload struct {
		Tools   []tools.Tool `json:"tools"`
		Version string       `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("nodecallback: decode catalog: %w", err)
	}
	return payload.Tools, nil
}
