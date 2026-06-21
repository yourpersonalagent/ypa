package stream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// defaultMaxIter mirrors tool_max_iter in the JS version. Eight rounds
// of (model → tools → model) covers nearly every realistic workflow
// and keeps a runaway loop bounded.
const defaultMaxIter = 8

// Run drives the multi-turn streaming chat loop. Each iteration:
//
//  1. Renders the current messages + tool catalog into the provider's
//     request shape via Provider.BuildRequest.
//  2. POSTs to the provider's endpoint.
//  3. Streams the response through Provider.Stream, emitting Chunks
//     via the supplied emit function and accumulating any tool calls
//     the model wants to make.
//  4. If no tool calls and the provider signalled done, emits a final
//     "done" Chunk and returns nil.
//  5. Otherwise runs each tool via runner.Run, appends an assistant
//     message + tool result messages to the history, and loops back to
//     step 1 — up to opts.MaxIter total iterations.
//
// Context cancellation propagates everywhere; in-flight HTTP calls
// abort and the function returns ctx.Err().
//
// Errors mid-stream emit a ChunkTypeError before returning; transport
// failures before any chunk is emitted return without emitting.
func Run(
	ctx context.Context,
	provider Provider,
	runner ToolRunner,
	messages []Message,
	tools []Tool,
	opts Opts,
	emit EmitFn,
) error {
	if provider == nil {
		return errors.New("stream: nil provider")
	}
	if emit == nil {
		emit = func(Chunk) {} // permissive default
	}
	maxIter := opts.MaxIter
	if maxIter <= 0 {
		maxIter = defaultMaxIter
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		// No short timeout: reasoning models (OpenAI o1/o3 etc.) and long
		// agent/tool turns legitimately need 30-60+ minutes for a single
		// iteration (first token latency + slow streaming + tool wall time).
		// Runaway protection is provided by explicit /v1/stop, the Node 60m
		// live-msg sweeper (which now also signals stop), per-harness
		// deadlines, and OS process binding. A 5m blanket timeout used to
		// silently kill long-but-valid turns mid-reasoning.
		httpClient = &http.Client{Timeout: 0}
	}

	requestOpts := RequestOpts{Stream: true}
	providerName := provider.Name()
	totalStart := time.Now()
	finalStatus := "done"
	defer func() {
		// Total per-call latency + outcome counter. Always recorded
		// when a Recorder is attached, regardless of which exit path
		// finalStatus took.
		if opts.Recorder == nil {
			return
		}
		opts.Recorder.IncCounter("stream_request_count", map[string]string{
			"provider": providerName,
			"status":   finalStatus,
		})
		opts.Recorder.Observe("stream_request_duration_ms",
			map[string]string{"provider": providerName},
			float64(time.Since(totalStart).Microseconds())/1000.0)
	}()

	for iter := 0; iter < maxIter; iter++ {
		// One model API call per iteration. The route surfaces this on
		// `_live` frames so the busy bar's "API×N" counts up as a
		// tool-use turn loops. Bumped before BuildRequest so the very
		// first frame after the call already reflects it.
		if opts.APICallCount != nil {
			opts.APICallCount.Add(1)
		}
		// One observation per tool-call ping-pong iteration so we can
		// distinguish a 1-shot completion from an 8-iter dance.
		if opts.Recorder != nil {
			opts.Recorder.IncCounter("stream_iteration_count",
				map[string]string{"provider": providerName})
		}
		if err := ctx.Err(); err != nil {
			finalStatus = "error"
			return err
		}

		body, err := provider.BuildRequest(messages, tools, requestOpts)
		if err != nil {
			emit(errorChunk(provider, fmt.Errorf("build request: %w", err)))
			finalStatus = "error"
			return err
		}
		// Per-iteration request audit log. Captures the actual upstream
		// request body so a botched answer can be traced back to the
		// exact prompt the model saw. Mirrors Node's per-turn logRaw
		// 'model'/'in' calls scattered across openai-internal.ts /
		// providers.
		if opts.RawLog != nil {
			var pretty any
			if err := json.Unmarshal(body, &pretty); err != nil {
				pretty = string(body)
			}
			opts.RawLog.Write("model", "in", pretty, map[string]any{
				"provider":  provider.Name(),
				"iteration": iter,
				"sessionId": opts.SessionID,
			})
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, provider.Endpoint(), bytes.NewReader(body))
		if err != nil {
			emit(errorChunk(provider, fmt.Errorf("build http request: %w", err)))
			finalStatus = "error"
			return err
		}
		for k, vv := range provider.Headers(opts.APIKey) {
			req.Header[k] = vv
		}

		resp, err := doProviderRequest(ctx, opts.Limiter, providerName, httpClient, req)
		if err != nil {
			emit(errorChunk(provider, fmt.Errorf("http: %w", err)))
			finalStatus = "error"
			return err
		}

		if resp.StatusCode >= 400 {
			respBody, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			err := fmt.Errorf("provider %s returned %d: %s", provider.Name(), resp.StatusCode, truncate(string(respBody), 1024))
			emit(errorChunk(provider, err))
			finalStatus = "error"
			return err
		}

		toolCalls, done, err := provider.Stream(ctx, resp.Body, emit)
		_ = resp.Body.Close()
		if err != nil {
			emit(errorChunk(provider, fmt.Errorf("stream: %w", err)))
			finalStatus = "error"
			return err
		}

		// No tool calls and the provider signalled stop → conversation done.
		if done && len(toolCalls) == 0 {
			doneChunk := Chunk{Type: ChunkTypeDone, DoneReason: "stop", Provider: provider.Name()}
			if u := readProviderUsage(provider); !u.IsZero() {
				ucopy := u
				doneChunk.Usage = &ucopy
			}
			emit(doneChunk)
			return nil
		}

		if len(toolCalls) == 0 {
			// Provider didn't ask for tools and didn't say "done" —
			// treat as protocol error rather than infinite-looping.
			err := errors.New("stream: provider returned no chunks and no done signal")
			emit(errorChunk(provider, err))
			finalStatus = "error"
			return err
		}

		// Append assistant turn (model's choice to use tools).
		messages = append(messages, Message{
			Role:      "assistant",
			ToolCalls: toolCalls,
		})

		// Run each tool the model asked for, append the result as a
		// role=tool message that the next turn will see.
		for _, tc := range toolCalls {
			result, runErr := runToolSafely(ctx, runner, tc)
			emit(Chunk{
				Type:       ChunkTypeToolResult,
				ToolResult: result,
				Provider:   provider.Name(),
			})
			messages = append(messages, Message{
				Role:       "tool",
				Content:    result.Content,
				ToolCallID: tc.ID,
			})
			if runErr != nil && opts.Logger != nil {
				opts.Logger.Warn("stream.tool-run", "name", tc.Name, "err", runErr)
			}
		}

		// Drain any #btw items the user dropped into the session
		// during this tool round and inject them as a synthetic user
		// message before the next API call. Mirrors Node's
		// drainBtw + formatBtwInjection pattern from tools/stream.ts.
		// The emitted btwInjected chunk lets the FE render the items
		// inline alongside tool calls so the user sees their context
		// landed.
		if opts.Btw != nil && opts.SessionID != "" {
			if items := opts.Btw.Drain(opts.SessionID); len(items) > 0 {
				injection := FormatBtwInjection(items)
				messages = append(messages, Message{
					Role:    "user",
					Content: injection,
				})
				emit(Chunk{
					Type:     "btwInjected",
					Text:     injection,
					Provider: provider.Name(),
				})
			}
		}
	}

	doneChunk := Chunk{Type: ChunkTypeDone, DoneReason: "max_iter", Provider: provider.Name()}
	if u := readProviderUsage(provider); !u.IsZero() {
		ucopy := u
		doneChunk.Usage = &ucopy
	}
	emit(doneChunk)
	finalStatus = "max_iter"
	return nil
}

// readProviderUsage returns the running usage from a Provider that
// implements UsageProvider, or the zero Usage if it doesn't. Used by
// Run to stamp the terminal done chunk; the route reads the same
// total via its direct reference to the underlying provider.
func readProviderUsage(p Provider) Usage {
	if up, ok := p.(UsageProvider); ok {
		return up.Usage()
	}
	return Usage{}
}

// runToolSafely invokes the runner and converts its outputs into a
// ToolResultChunk. Genuine system errors are still recorded but the
// chunk always has a usable Content so the next turn can continue.
func runToolSafely(ctx context.Context, runner ToolRunner, tc ToolUseChunk) (*ToolResultChunk, error) {
	if runner == nil {
		return &ToolResultChunk{ID: tc.ID, OK: false, Error: "no tool runner configured"}, nil
	}
	res, err := runner.Run(ctx, tc.Name, tc.Input)
	if err != nil {
		return &ToolResultChunk{ID: tc.ID, OK: false, Error: err.Error()}, err
	}
	if res == nil {
		return &ToolResultChunk{ID: tc.ID, OK: false, Error: "tool returned nil result"}, nil
	}
	out := &ToolResultChunk{
		ID:      tc.ID,
		OK:      res.OK,
		Content: res.Content,
		Error:   res.Error,
	}
	return out, nil
}

func errorChunk(p Provider, err error) Chunk {
	c := Chunk{Type: ChunkTypeError, Error: err.Error()}
	if p != nil {
		c.Provider = p.Name()
	}
	return c
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// doProviderRequest issues the upstream HTTP call. When a RateLimiter
// is configured (production via opts.Limiter wired from RouteDeps), the
// call passes through Limiter.With so the per-provider token bucket +
// concurrency cap + 429 retry behaviour from internal/rate apply. When
// limiter is nil (tests, legacy callers) the call falls back to the
// raw httpClient.Do so existing test fixtures keep working unchanged.
//
// The original request's context is replaced inside the closure so the
// limiter's per-attempt sleep on 429 is honoured against the caller's
// cancellation rather than dangling beyond it.
func doProviderRequest(
	ctx context.Context,
	limiter RateLimiter,
	provider string,
	httpClient *http.Client,
	req *http.Request,
) (*http.Response, error) {
	if limiter == nil {
		return httpClient.Do(req)
	}
	return limiter.With(ctx, provider, func(c context.Context) (*http.Response, error) {
		return httpClient.Do(req.WithContext(c))
	})
}
