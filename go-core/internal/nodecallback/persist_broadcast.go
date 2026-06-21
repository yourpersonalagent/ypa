// Phase 6g/7: persist-broadcast-message callback. After each employee in
// a Go-side broadcast / versus chain finalizes, the runner fires this
// payload at Node's /internal/persist-broadcast-message so the assistant
// reply lands in bridge/sessions/<sid>.json — same place the Node-side
// runner has been writing for the legacy path. Without this hop, Go-owned
// broadcast turns would survive only in the SSE pipe and disappear on
// reload.
//
// Fire-and-forget from the caller's perspective, like CostEventClient:
// 5 s per-attempt timeout bounds the round-trip; non-2xx surfaces as an
// error so the runner's logger can flag persistence regressions.
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

// defaultPersistBroadcastTimeout caps each Node round-trip. Matches the
// cost-event budget so the broadcast runner's per-employee tail doesn't
// drag if Node briefly stalls (debounced disk save, GC pause, etc.).
const defaultPersistBroadcastTimeout = 5 * time.Second

// PersistBroadcastMessageClient POSTs each employee's finalized reply to
// Node's /internal/persist-broadcast-message endpoint. Construct once per
// daemon; safe for concurrent use.
type PersistBroadcastMessageClient struct {
	nodeURL    string
	bridgeKey  string
	log        *logger.Logger
	httpClient *http.Client
}

// NewPersistBroadcastMessageClient builds a client bound to the given
// Node URL + bridge key. baseURL is the bare base (no trailing slash);
// a nil logger is replaced with a no-op writer.
func NewPersistBroadcastMessageClient(baseURL, bridgeKey string, log *logger.Logger) *PersistBroadcastMessageClient {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &PersistBroadcastMessageClient{
		nodeURL:   strings.TrimRight(baseURL, "/"),
		bridgeKey: bridgeKey,
		log:       log,
		httpClient: &http.Client{
			Timeout: defaultPersistBroadcastTimeout,
		},
	}
}

// PersistBroadcastAuthor is the embedded author block the FE renders as
// the per-employee message header. Matches the saveEmp(...) shape in
// bridge/modules/multichat-broadcast/runner.ts:155-198.
type PersistBroadcastAuthor struct {
	ID          string `json:"id"`
	Name        string `json:"name,omitempty"`
	Role        string `json:"role,omitempty"`
	SymbolColor string `json:"symbolColor,omitempty"`
}

// PersistBroadcastMessagePayload is the body POSTed to
// /internal/persist-broadcast-message. Field names match the Node-side
// handler in bridge/routes/internal.ts. Blocks is the rich
// per-segment array Node will store as the message's `blocks` field
// in displaySessions; when empty the text-only legacy path is used.
type PersistBroadcastMessagePayload struct {
	SessionID    string                  `json:"sessionId"`
	EmployeeID   string                  `json:"employeeId"`
	Text         string                  `json:"text"`
	Blocks       []map[string]any        `json:"blocks,omitempty"`
	Model        string                  `json:"model,omitempty"`
	Role         string                  `json:"role,omitempty"`
	InputTokens  int                     `json:"inputTokens,omitempty"`
	OutputTokens int                     `json:"outputTokens,omitempty"`
	DurationMs   int                     `json:"durationMs,omitempty"`
	StopReason   string                  `json:"stopReason,omitempty"`
	Author       *PersistBroadcastAuthor `json:"author,omitempty"`
	// Phase is the live-message lifecycle stage: "start" pushes a
	// streaming:true placeholder and returns LiveToken; "update"
	// debounced-saves text/blocks against the existing placeholder;
	// "final" strips the streaming flag. Empty = legacy push-and-go.
	// Mirrors Node sessions-internal.startLiveMsg/updateLiveMsg/finalizeLiveMsg.
	Phase     string `json:"phase,omitempty"`
	LiveToken int64  `json:"liveToken,omitempty"`
	// Live counters for durability of the busy meta bar across switches,
	// reloads and brief bridge restarts (the values are snapshots of Go
	// core's live ticker at checkpoint time; growth continues from the
	// registry / activity feed while the turn is live in core).
	ToolCallCount int   `json:"toolCallCount,omitempty"`
	APICallCount  int   `json:"apiCallCount,omitempty"`
	TurnStartMs   int64 `json:"turnStartMs,omitempty"`
}

// PersistBroadcastMessageResponse carries the optional liveToken
// returned by phase="start" so the caller can pin subsequent
// update/final calls to the same placeholder entry.
type PersistBroadcastMessageResponse struct {
	Success   bool  `json:"success"`
	OK        bool  `json:"ok"`
	LiveToken int64 `json:"liveToken,omitempty"`
}

// FinalizeAbandoned asks Node to clear any streaming placeholders for a
// session after Go has stopped or lost the owning adapter. Node owns the
// in-memory display session, so Go cannot safely do this in SQLite alone.
func (c *PersistBroadcastMessageClient) FinalizeAbandoned(ctx context.Context, sessionID, reason string) error {
	if c == nil {
		return errors.New("nodecallback: nil PersistBroadcastMessageClient")
	}
	if c.nodeURL == "" {
		return errors.New("nodecallback: no NodeURL configured")
	}
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("nodecallback: sessionId required")
	}
	body, err := json.Marshal(map[string]string{
		"sessionId": sessionID,
		"reason":    reason,
	})
	if err != nil {
		return fmt.Errorf("nodecallback: marshal finalize-abandoned-live: %w", err)
	}
	url := c.nodeURL + "/internal/finalize-abandoned-live"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("nodecallback: build finalize-abandoned-live request: %w", err)
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
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("nodecallback: finalize-abandoned-live returned %d: %s",
			resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

// Persist POSTs the payload to /internal/persist-broadcast-message.
// Returns nil on 2xx; transport / non-2xx errors surface so callers can
// log or retry. The broadcast runner fires this via its own goroutine
// with a fresh timeout — see runner.go.
func (c *PersistBroadcastMessageClient) Persist(ctx context.Context, payload PersistBroadcastMessagePayload) error {
	if c == nil {
		return errors.New("nodecallback: nil PersistBroadcastMessageClient")
	}
	if c.nodeURL == "" {
		return errors.New("nodecallback: no NodeURL configured")
	}
	if payload.SessionID == "" {
		return errors.New("nodecallback: sessionId required")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("nodecallback: marshal persist-broadcast-message: %w", err)
	}

	url := c.nodeURL + "/internal/persist-broadcast-message"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("nodecallback: build persist-broadcast-message request: %w", err)
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
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("nodecallback: persist-broadcast-message returned %d: %s",
			resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

// PersistWithToken is the variant that reads the response body so the
// caller can pick up the live-message token returned by phase="start".
// Subsequent update/final calls pin to the same placeholder via this
// token. Non-2xx responses still surface as errors.
func (c *PersistBroadcastMessageClient) PersistWithToken(ctx context.Context, payload PersistBroadcastMessagePayload) (PersistBroadcastMessageResponse, error) {
	var out PersistBroadcastMessageResponse
	if c == nil {
		return out, errors.New("nodecallback: nil PersistBroadcastMessageClient")
	}
	if c.nodeURL == "" {
		return out, errors.New("nodecallback: no NodeURL configured")
	}
	if payload.SessionID == "" {
		return out, errors.New("nodecallback: sessionId required")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return out, fmt.Errorf("nodecallback: marshal persist-broadcast-message: %w", err)
	}
	url := c.nodeURL + "/internal/persist-broadcast-message"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return out, fmt.Errorf("nodecallback: build persist-broadcast-message request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.bridgeKey != "" {
		req.Header.Set("x-bridge-key", c.bridgeKey)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return out, fmt.Errorf("nodecallback: POST %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return out, fmt.Errorf("nodecallback: persist-broadcast-message returned %d: %s",
			resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, fmt.Errorf("nodecallback: decode persist-broadcast-message response: %w", err)
	}
	return out, nil
}
