// cost-event + auto-title callbacks — Go's stream loop posts to Node's
// /internal/cost-event after each finalize so observability-plus stays
// authoritative for costs/tokens, then triggers context-generator's
// auto-title worker via /internal/auto-title.
//
// Both calls are fire-and-forget from the route's perspective: a 5s
// timeout bounds the round-trip, transport / non-200 errors log a
// Warn but never propagate up. Phase 5's contract is "telemetry is
// best-effort; missing data degrades dashboards, never the chat turn."
package nodecallback

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/yha/core/internal/logger"
)

// defaultCostEventTimeout caps each Node round-trip. 5 s gives the
// bridge plenty of headroom even on a cold-boot 30 s eager-load — the
// alternative is blocking the chat turn's finalize, which is worse.
const defaultCostEventTimeout = 5 * time.Second

// CostEventClient POSTs finalize-time payloads to Node's two internal
// telemetry endpoints. One per daemon process; safe for concurrent use.
type CostEventClient struct {
	nodeURL    string
	bridgeKey  string
	log        *logger.Logger
	httpClient *http.Client
}

// NewCostEventClient builds a client bound to the given Node URL +
// bridge key. nodeURL is the bare base (no trailing slash); a nil
// logger is replaced with a no-op writer so the daemon stays quiet
// during unit tests.
func NewCostEventClient(nodeURL, bridgeKey string, log *logger.Logger) *CostEventClient {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &CostEventClient{
		nodeURL:   strings.TrimRight(nodeURL, "/"),
		bridgeKey: bridgeKey,
		log:       log,
		httpClient: &http.Client{
			Timeout: defaultCostEventTimeout,
		},
	}
}

// CostEventPayload is the body POSTed to /internal/cost-event. Field
// names match the Node-side handler in bridge/routes/internal.ts; the
// Node side computes `cost` from `model` + token counts when the field
// is zero/absent, so Go doesn't need to duplicate the rate table.
type CostEventPayload struct {
	SessionID           string             `json:"sessionId"`
	Model               string             `json:"model"`
	Provider            string             `json:"provider,omitempty"`
	InputTokens         int                `json:"inputTokens"`
	OutputTokens        int                `json:"outputTokens"`
	CacheReadTokens     int                `json:"cacheReadTokens,omitempty"`
	CacheCreationTokens int                `json:"cacheCreationTokens,omitempty"`
	Cost                float64            `json:"cost,omitempty"`
	ToolCallCount       int                `json:"toolCallCount,omitempty"`
	DurationMs          int64              `json:"durationMs"`
	Tools               []ToolEventRecord  `json:"tools,omitempty"`
}

// ToolEventRecord mirrors stream.ToolEventRecord. One record per
// tool_use chunk; Node fans these into surface:'tool' telemetry so
// #debug toolsmon captures model-native tool calls that happen inside
// the claude-binary subprocess.
type ToolEventRecord struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
}

// Record posts the payload to /internal/cost-event. Returns nil on
// successful 200; transport / non-200 errors are logged + returned so
// callers can decide whether to ignore. Callers in the stream route
// typically fire-and-forget via a goroutine — see EnqueueAutoTitle for
// the same pattern packaged.
func (c *CostEventClient) Record(ctx context.Context, payload CostEventPayload) error {
	if c.nodeURL == "" {
		return errors.New("nodecallback: no NodeURL configured")
	}
	if payload.SessionID == "" || payload.Model == "" {
		return errors.New("nodecallback: sessionId and model required")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("nodecallback: marshal cost-event: %w", err)
	}

	url := c.nodeURL + "/internal/cost-event"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("nodecallback: build cost-event request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.bridgeKey != "" {
		req.Header.Set("x-bridge-key", c.bridgeKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("nodecallback: POST %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("nodecallback: cost-event returned %d: %s",
			resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

// EnqueueAutoTitle posts {sessionId} to /internal/auto-title. The Node
// side's enqueueForAutoTitle is idempotent + short-circuits when a
// title already exists, so Go can fire on every finalize without
// special-casing first-turn-only.
func (c *CostEventClient) EnqueueAutoTitle(ctx context.Context, sessionID string) error {
	if c.nodeURL == "" {
		return errors.New("nodecallback: no NodeURL configured")
	}
	if sessionID == "" {
		return errors.New("nodecallback: sessionId required")
	}

	body, _ := json.Marshal(map[string]string{"sessionId": sessionID})
	url := c.nodeURL + "/internal/auto-title"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("nodecallback: build auto-title request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.bridgeKey != "" {
		req.Header.Set("x-bridge-key", c.bridgeKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("nodecallback: POST %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("nodecallback: auto-title returned %d: %s",
			resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

// FireAndForget runs fn on a fresh goroutine bounded by the configured
// timeout, logging any returned error. The stream route uses this to
// hand off cost-event + auto-title without making the user wait on
// Node's response.
func (c *CostEventClient) FireAndForget(label string, fn func(context.Context) error) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), defaultCostEventTimeout)
		defer cancel()
		if err := fn(ctx); err != nil {
			c.log.Warn("nodecallback.fire-and-forget", "label", label, "err", err)
		}
	}()
}
