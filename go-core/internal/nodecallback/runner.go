// Node-callback runner — POSTs /proxy/tool on the Node bridge to invoke
// a module-provided tool whose handler lives in Node (AskUser, RunCode,
// Task, etc.). The composite runner dispatches a tool here whenever the
// catalog records its source as a Node module.
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
	"github.com/yha/core/internal/tools"
)

// defaultRunnerTimeout matches the JS side's per-tool budget for the
// chat loop. Most calls finish in seconds; the slow tails (RunCode with
// network access, Task agents) sometimes climb toward 30s.
const defaultRunnerTimeout = 60 * time.Second

// Runner POSTs to <NodeURL>/proxy/tool for each module-served tool.
// One Runner per daemon process; safe for concurrent calls.
type Runner struct {
	nodeURL    string
	bridgeKey  string
	log        *logger.Logger
	httpClient *http.Client
}

// NewRunner constructs a Runner. A nil logger is replaced with a no-op.
func NewRunner(nodeURL, bridgeKey string, log *logger.Logger) *Runner {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &Runner{
		nodeURL:   strings.TrimRight(nodeURL, "/"),
		bridgeKey: bridgeKey,
		log:       log,
		httpClient: &http.Client{
			Timeout: defaultRunnerTimeout,
		},
	}
}

// Run invokes a Node-side tool over /proxy/tool. The request body
// matches what executeBridgeTool expects on the Node side:
//
//	{name, input, cwd, sessionId}
//
// The response shape is the existing /proxy/tool one (`{result}` on
// success or `{error}` on failure). Successful results land in
// Result.Content; failures land in Result.Error with OK=false.
//
// Genuine system errors (transport, JSON decode, context cancellation)
// propagate as the second return value. Tool-level failures (Node says
// 4xx/5xx with an `error` field) come back as OK=false results.
func (r *Runner) Run(ctx context.Context, name string, args map[string]any, cwd, sessionID string) (*tools.Result, error) {
	if r.nodeURL == "" {
		return nil, errors.New("nodecallback: no NodeURL configured")
	}
	if name == "" {
		return &tools.Result{OK: false, Error: "nodecallback: name required"}, nil
	}
	if args == nil {
		args = map[string]any{}
	}

	body, err := json.Marshal(map[string]any{
		"name":      name,
		"input":     args,
		"cwd":       cwd,
		"sessionId": sessionID,
	})
	if err != nil {
		return nil, fmt.Errorf("nodecallback: marshal: %w", err)
	}

	url := r.nodeURL + "/proxy/tool"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("nodecallback: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if r.bridgeKey != "" {
		req.Header.Set("x-bridge-key", r.bridgeKey)
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("nodecallback: POST %s: %w", url, err)
	}
	defer resp.Body.Close()

	rawBody, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	if resp.StatusCode != http.StatusOK {
		// Try to extract Node's `{error: "..."}` JSON; fall back to raw text.
		errMsg := strings.TrimSpace(string(rawBody))
		var envelope struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(rawBody, &envelope) == nil && envelope.Error != "" {
			errMsg = envelope.Error
		}
		return &tools.Result{
			OK:    false,
			Error: fmt.Sprintf("node /proxy/tool returned %d: %s", resp.StatusCode, errMsg),
		}, nil
	}

	// Successful body shape: {result: "..."} where result is already
	// stringified by Node-side executeBridgeTool.
	var envelope struct {
		Result string `json:"result"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal(rawBody, &envelope); err != nil {
		return nil, fmt.Errorf("nodecallback: decode response: %w", err)
	}
	if envelope.Error != "" {
		return &tools.Result{OK: false, Error: envelope.Error}, nil
	}
	return &tools.Result{OK: true, Content: envelope.Result}, nil
}
