package nodecallback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRunnerPostsExpectedBody(t *testing.T) {
	var (
		gotMethod, gotKey, gotCT atomic.Value
		gotBody                  atomic.Value
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod.Store(r.Method)
		gotKey.Store(r.Header.Get("x-bridge-key"))
		gotCT.Store(r.Header.Get("Content-Type"))
		body, _ := io.ReadAll(r.Body)
		gotBody.Store(string(body))
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "ok"})
	}))
	defer srv.Close()

	r := NewRunner(srv.URL, "the-key", nil)
	res, err := r.Run(context.Background(), "AskUser",
		map[string]any{"question": "ready?"},
		"/some/cwd",
		"sid-42",
	)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.OK {
		t.Fatalf("res not OK: %+v", res)
	}
	if res.Content != "ok" {
		t.Errorf("Content = %q, want 'ok'", res.Content)
	}
	if gotMethod.Load() != "POST" {
		t.Errorf("method = %v, want POST", gotMethod.Load())
	}
	if gotKey.Load() != "the-key" {
		t.Errorf("auth header = %v, want the-key", gotKey.Load())
	}
	if ct, _ := gotCT.Load().(string); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}

	var sent map[string]any
	if err := json.Unmarshal([]byte(gotBody.Load().(string)), &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent["name"] != "AskUser" {
		t.Errorf("body.name = %v, want AskUser", sent["name"])
	}
	if sent["cwd"] != "/some/cwd" {
		t.Errorf("body.cwd = %v, want /some/cwd", sent["cwd"])
	}
	if sent["sessionId"] != "sid-42" {
		t.Errorf("body.sessionId = %v, want sid-42", sent["sessionId"])
	}
	input, _ := sent["input"].(map[string]any)
	if input["question"] != "ready?" {
		t.Errorf("body.input.question = %v, want ready?", input["question"])
	}
}

func TestRunnerNon200ProducesOKFalse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "broken inside"})
	}))
	defer srv.Close()

	r := NewRunner(srv.URL, "k", nil)
	res, err := r.Run(context.Background(), "Whatever", nil, "", "")
	if err != nil {
		t.Fatalf("transport err: %v", err)
	}
	if res.OK {
		t.Error("expected OK=false on 500")
	}
	if !strings.Contains(res.Error, "broken inside") {
		t.Errorf("Error = %q, want it to mention 'broken inside'", res.Error)
	}
	if !strings.Contains(res.Error, "500") {
		t.Errorf("Error = %q, want it to mention the status", res.Error)
	}
}

func TestRunnerResultEnvelopeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "tool failed"})
	}))
	defer srv.Close()

	r := NewRunner(srv.URL, "k", nil)
	res, err := r.Run(context.Background(), "X", nil, "", "")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.OK || res.Error != "tool failed" {
		t.Errorf("res = %+v", res)
	}
}

func TestRunnerEmptyName(t *testing.T) {
	r := NewRunner("http://example", "k", nil)
	res, err := r.Run(context.Background(), "", nil, "", "")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.OK || !strings.Contains(res.Error, "name") {
		t.Errorf("res = %+v, want OK=false with 'name' error", res)
	}
}

func TestRunnerNoNodeURL(t *testing.T) {
	r := NewRunner("", "k", nil)
	if _, err := r.Run(context.Background(), "X", nil, "", ""); err == nil {
		t.Error("expected err with empty NodeURL")
	}
}
