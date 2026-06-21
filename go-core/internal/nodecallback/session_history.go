// Session-history loader. Pre-Phase-7 Node owned /v1/stream/ and read
// the LLM context via getHistory(sid) in-process; after the Go cutover
// the front door is in Go but the chatHistory state still lives in
// Node, so the route handler has to hop across the process boundary
// to thread prior-turn context into each upstream call. Without this
// hop every chat turn looked like turn #1 to the model.
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

// defaultSessionHistoryTimeout caps each fetch. Kept short because the
// call sits on the critical path — every chat turn waits on it before
// the upstream model request can fire.
const defaultSessionHistoryTimeout = 3 * time.Second

// SessionHistoryClient fetches the LLM-context history for a session
// from Node's /internal/session-history endpoint.
type SessionHistoryClient struct {
	nodeURL    string
	bridgeKey  string
	log        *logger.Logger
	httpClient *http.Client
}

// NewSessionHistoryClient builds a client bound to the given Node URL +
// bridge key. baseURL is the bare base (no trailing slash); a nil
// logger is replaced with a no-op writer.
func NewSessionHistoryClient(baseURL, bridgeKey string, log *logger.Logger) *SessionHistoryClient {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &SessionHistoryClient{
		nodeURL:   strings.TrimRight(baseURL, "/"),
		bridgeKey: bridgeKey,
		log:       log,
		httpClient: &http.Client{
			Timeout: defaultSessionHistoryTimeout,
		},
	}
}

// HistoryMessage is one entry returned by Node's session-history
// endpoint. Mirrors the wire shape (role + content) without leaking
// the stream package's Message struct.
type HistoryMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Load fetches the session's prior-turn LLM context. selfEmpId scopes
// the result to one employee's perspective in versus / broadcast mode
// (other employees' assistant turns become `[Name]: ...` user
// messages); empty = the shared default history. Returns nil + nil
// when no history is configured (e.g. brand-new session) — callers
// should treat both empty and nil the same way.
func (c *SessionHistoryClient) Load(ctx context.Context, sessionID, selfEmpID string) ([]HistoryMessage, error) {
	if c == nil {
		return nil, errors.New("nodecallback: nil SessionHistoryClient")
	}
	if c.nodeURL == "" {
		return nil, errors.New("nodecallback: no NodeURL configured")
	}
	if sessionID == "" {
		return nil, nil
	}
	payload := map[string]string{"sessionId": sessionID}
	if strings.TrimSpace(selfEmpID) != "" {
		payload["selfEmpId"] = strings.TrimSpace(selfEmpID)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.nodeURL+"/internal/session-history", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-bridge-key", c.bridgeKey)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		text, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("session-history: status %d: %s", resp.StatusCode, strings.TrimSpace(string(text)))
	}
	var out struct {
		Success  bool             `json:"success"`
		Messages []HistoryMessage `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if !out.Success {
		return nil, errors.New("session-history: success=false")
	}
	return out.Messages, nil
}
