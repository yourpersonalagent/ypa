// agent-turn callbacks — Go's stream route posts to Node's
// /internal/agent-turn at the start of every chat turn so the bridge's
// rewind recorder can tag records written during the turn with a
// per-turn id. Without this, the bridge falls back to a process-wide
// uuid minted at module load — records group by bridge restart, not
// by chat turn. With this wired, every record written between Set and
// Clear carries the same agent_turn_id so the rewind UI can group
// edits within a single user message.
//
// Both calls are fire-and-forget from the route's perspective: a 2s
// timeout bounds the round-trip and transport / non-200 errors log a
// Warn but never propagate up. The rewind feature degrades gracefully
// when the bridge's /internal/agent-turn is unreachable (records just
// fall back to the process-wide id).
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

// defaultAgentTurnTimeout caps each Node round-trip. 2 s is plenty for
// a localhost POST that just writes a string into rewind state; if the
// bridge is slower than that, the chat turn shouldn't wait.
const defaultAgentTurnTimeout = 2 * time.Second

// AgentTurnClient POSTs per-turn ids to Node's /internal/agent-turn.
// One per daemon process; safe for concurrent calls.
type AgentTurnClient struct {
	nodeURL    string
	bridgeKey  string
	log        *logger.Logger
	httpClient *http.Client
}

// NewAgentTurnClient builds a client bound to the given Node URL +
// bridge key. nodeURL is the bare base (no trailing slash); a nil
// logger is replaced with a no-op writer so the daemon stays quiet
// during unit tests.
func NewAgentTurnClient(nodeURL, bridgeKey string, log *logger.Logger) *AgentTurnClient {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &AgentTurnClient{
		nodeURL:   strings.TrimRight(nodeURL, "/"),
		bridgeKey: bridgeKey,
		log:       log,
		httpClient: &http.Client{
			Timeout: defaultAgentTurnTimeout,
		},
	}
}

// Set tags all subsequent rewind records with turnID until the next
// Set or Clear. Empty turnID is rejected — use Clear for that path.
func (c *AgentTurnClient) Set(ctx context.Context, turnID string) error {
	if strings.TrimSpace(turnID) == "" {
		return errors.New("nodecallback: agent-turn id required (use Clear to reset)")
	}
	return c.post(ctx, map[string]any{"turn_id": turnID})
}

// Clear resets the active turn id so the bridge mints a fresh
// process-wide fallback for records written between turns.
func (c *AgentTurnClient) Clear(ctx context.Context) error {
	return c.post(ctx, map[string]any{})
}

func (c *AgentTurnClient) post(ctx context.Context, payload map[string]any) error {
	if c.nodeURL == "" {
		return errors.New("nodecallback: no NodeURL configured")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("nodecallback: marshal agent-turn: %w", err)
	}
	url := c.nodeURL + "/internal/agent-turn"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("nodecallback: build agent-turn request: %w", err)
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
		return fmt.Errorf("nodecallback: agent-turn returned %d: %s",
			resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

// FireSet runs Set on a fresh goroutine and logs any error. Used by
// the stream route at turn boundaries so the round-trip never blocks
// the user-visible chat turn.
func (c *AgentTurnClient) FireSet(turnID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), defaultAgentTurnTimeout)
		defer cancel()
		if err := c.Set(ctx, turnID); err != nil {
			c.log.Warn("nodecallback.agent-turn.set", "err", err, "turn_id", turnID)
		}
	}()
}

// FireClear runs Clear on a fresh goroutine and logs any error.
func (c *AgentTurnClient) FireClear() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), defaultAgentTurnTimeout)
		defer cancel()
		if err := c.Clear(ctx); err != nil {
			c.log.Warn("nodecallback.agent-turn.clear", "err", err)
		}
	}()
}
