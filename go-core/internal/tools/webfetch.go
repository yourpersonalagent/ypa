// WebFetch tool — Go port of the fetch() branch in
// bridge/tools/exec.ts. The model just gets back the raw bytes
// (capped at 5 MiB); HTML parsing/summarisation is a downstream
// concern handled by callers that actually want it.
//
// Hardening:
//   - URL passes through security.ValidateFetchURL (SSRF guard)
//   - 30 s timeout via http.Client.Timeout AND ctx
//   - Body read capped via io.LimitReader so a hostile server can't
//     OOM us by streaming forever
package tools

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"
)

const (
	webFetchMaxBytes = 5 * 1024 * 1024 // 5 MiB
	webFetchUA       = "yha-core/0.1"
	webFetchTimeout  = 30 * time.Second
)

// safeFetchClient returns an http.Client whose dialer rejects connections to
// private/loopback/metadata IPs. The Control hook fires after DNS resolution
// with the concrete remote address, so it blocks DNS-rebinding attacks that
// pass ValidateFetchURL (which resolves at a different moment) but then resolve
// to an internal IP at connect time. Redirects are re-checked because the
// default http.Client re-dials through this same transport for each hop.
func safeFetchClient() *http.Client {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 10 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				host = address
			}
			if IsPrivateIP(host) {
				return fmt.Errorf("blocked connection to private address %s", host)
			}
			return nil
		},
	}
	return &http.Client{
		Timeout:   webFetchTimeout,
		Transport: &http.Transport{DialContext: dialer.DialContext},
	}
}

// webFetchRun fetches args["url"] and returns the body as a string.
// Caller may pass args["prompt"] for downstream LLM summarisation;
// this layer just attaches it as Meta.
func (e *Executor) webFetchRun(ctx context.Context, args map[string]any) (*Result, error) {
	rawURL := argString(args, "url", "")
	if rawURL == "" {
		return &Result{OK: false, Error: "WebFetch: missing url"}, nil
	}
	safeURL, err := ValidateFetchURL(rawURL)
	if err != nil {
		return errResult(err), nil
	}

	client := safeFetchClient()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, safeURL, nil)
	if err != nil {
		return &Result{OK: false, Error: "WebFetch: " + err.Error()}, nil
	}
	req.Header.Set("User-Agent", webFetchUA)

	resp, err := client.Do(req)
	if err != nil {
		return &Result{OK: false, Error: "WebFetch: " + err.Error()}, nil
	}
	defer resp.Body.Close()

	limited := io.LimitReader(resp.Body, webFetchMaxBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return &Result{OK: false, Error: "WebFetch: " + err.Error()}, nil
	}
	truncated := false
	if len(body) > webFetchMaxBytes {
		body = body[:webFetchMaxBytes]
		truncated = true
	}

	contentType := strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0]
	contentType = strings.TrimSpace(contentType)

	prompt := argString(args, "prompt", "")
	meta := map[string]any{
		"status":       resp.StatusCode,
		"content_type": contentType,
		"bytes":        len(body),
		"truncated":    truncated,
	}
	if prompt != "" {
		meta["prompt"] = prompt
	}

	return &Result{
		OK:      resp.StatusCode >= 200 && resp.StatusCode < 400,
		Content: stringFromBytes(body),
		Meta:    meta,
	}, nil
}

// stringFromBytes converts a body slice to a string after trimming
// trailing NULs (servers occasionally null-pad responses; rendering
// that to the model is just noise).
func stringFromBytes(b []byte) string {
	for len(b) > 0 && b[len(b)-1] == 0 {
		b = b[:len(b)-1]
	}
	return string(b)
}
