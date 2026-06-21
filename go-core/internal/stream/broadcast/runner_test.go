package broadcast

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/stream"
)

// mapLoader is the scripted EmployeeLoader used by every test in this
// file. nil values cover "no record" without falling through to a
// filesystem lookup.
type mapLoader map[string]*EmployeeRecord

func (m mapLoader) Load(id string) (*EmployeeRecord, error) {
	if rec, ok := m[id]; ok {
		return rec, nil
	}
	return nil, nil
}

// scriptedAdapter returns an Adapter that emits one delta with the
// supplied text, then a done chunk. It records every call it
// receives in `calls` (under mu) so tests can assert dispatch order.
func scriptedAdapter(text string, mu *sync.Mutex, calls *[]string) Adapter {
	return func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		mu.Lock()
		*calls = append(*calls, req.BroadcastEmp.ID)
		mu.Unlock()
		emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: text})
		emit(stream.Chunk{Type: stream.ChunkTypeDone, DoneReason: "stop"})
		return &harness.Result{Text: text, StopReason: "stop"}, nil
	}
}

func TestRunChain_SequentialEmitsAuthorsAndTexts(t *testing.T) {
	var mu sync.Mutex
	var calls []string

	runner := &Runner{
		Adapters: map[string]Adapter{
			AdapterDirectAPI: scriptedAdapter("alice-says-hi", &mu, &calls),
		},
		Employees: mapLoader{
			"alice": {ID: "alice", Name: "Alice", DefaultModel: "claude-opus-4-7"},
			"bob":   {ID: "bob", Name: "Bob", DefaultModel: "claude-opus-4-7"},
		},
		Now: func() time.Time { return time.Unix(1700000000, 0) },
	}

	// Bob gets a different reply so we can verify per-employee text
	// accumulation works when the adapter is re-used.
	runner.Adapters[AdapterDirectAPI] = func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		mu.Lock()
		calls = append(calls, req.BroadcastEmp.ID)
		mu.Unlock()
		var text string
		if req.BroadcastEmp.ID == "alice" {
			text = "alice-says-hi"
		} else {
			text = "bob-says-hello"
		}
		emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: text})
		emit(stream.Chunk{Type: stream.ChunkTypeDone})
		return &harness.Result{Text: text}, nil
	}

	var chunks []stream.Chunk
	emit := ChunkEmitter(func(c stream.Chunk) {
		chunks = append(chunks, c)
	})

	res, err := runner.RunChain(context.Background(), []string{"alice", "bob"}, "sequential", Request{
		SessionID: "sid-1",
		Input:     "hi",
		Model:     "claude-opus-4-7",
	}, emit)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	if res == nil || len(res.PerEmployee) != 2 {
		t.Fatalf("PerEmployee = %+v, want 2 entries", res)
	}
	if res.PerEmployee[0].EmployeeID != "alice" || res.PerEmployee[1].EmployeeID != "bob" {
		t.Errorf("dispatch order = %v, want [alice, bob]", []string{res.PerEmployee[0].EmployeeID, res.PerEmployee[1].EmployeeID})
	}
	if res.PerEmployee[0].Text != "alice-says-hi" || res.PerEmployee[1].Text != "bob-says-hello" {
		t.Errorf("per-employee text = [%q, %q]", res.PerEmployee[0].Text, res.PerEmployee[1].Text)
	}
	if !strings.Contains(res.Combined, "alice-says-hi") || !strings.Contains(res.Combined, "bob-says-hello") {
		t.Errorf("Combined = %q, want both replies", res.Combined)
	}

	// Verify chunk ordering: alice author → alice delta → alice done
	// → bob author → bob delta → bob done.
	if len(chunks) < 6 {
		t.Fatalf("got %d chunks, want at least 6: %+v", len(chunks), chunks)
	}
	// First author chunk: empty-text typed Text with an author tag in
	// the Reasoning field.
	if !strings.HasPrefix(chunks[0].Reasoning, "author\talice\t") {
		t.Errorf("chunk[0] = %+v, want author chunk for alice", chunks[0])
	}
	bobAuthorIdx := -1
	for i, c := range chunks {
		if strings.HasPrefix(c.Reasoning, "author\tbob\t") {
			bobAuthorIdx = i
			break
		}
	}
	if bobAuthorIdx < 3 {
		t.Errorf("bob author chunk index = %d, want > alice's delta", bobAuthorIdx)
	}

	// Sequential mode: chunks must NOT carry the per-author EmpID tag
	// reserved for versus mode.
	for i, c := range chunks {
		if c.Type == stream.ChunkTypeDelta && c.EmpID != "" {
			t.Errorf("chunk[%d] delta carries EmpID %q in sequential mode", i, c.EmpID)
		}
	}
}

func TestRunChain_VersusTagsEveryChunkWithEmpID(t *testing.T) {
	var mu sync.Mutex
	var calls []string

	// Adapter that fires several deltas so we can confirm every one
	// gets tagged.
	adapter := func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		mu.Lock()
		calls = append(calls, req.BroadcastEmp.ID)
		mu.Unlock()
		emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: "d1-" + req.BroadcastEmp.ID})
		emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: "d2-" + req.BroadcastEmp.ID})
		emit(stream.Chunk{Type: stream.ChunkTypeDone})
		return &harness.Result{Text: "d1-" + req.BroadcastEmp.ID + "d2-" + req.BroadcastEmp.ID}, nil
	}

	runner := &Runner{
		Adapters: map[string]Adapter{
			AdapterDirectAPI: adapter,
		},
		Employees: mapLoader{
			"alice": {ID: "alice", Name: "Alice"},
			"bob":   {ID: "bob", Name: "Bob"},
		},
		Now: func() time.Time { return time.Unix(1700000000, 0) },
	}

	var chunksMu sync.Mutex
	var chunks []stream.Chunk
	emit := ChunkEmitter(func(c stream.Chunk) {
		chunksMu.Lock()
		defer chunksMu.Unlock()
		chunks = append(chunks, c)
	})

	res, err := runner.RunChain(context.Background(), []string{"alice", "bob"}, "versus", Request{SessionID: "sid-vs"}, emit)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	if len(res.PerEmployee) != 2 {
		t.Fatalf("PerEmployee len = %d, want 2", len(res.PerEmployee))
	}

	// Every non-author chunk must be tagged via the typed EmpID field.
	taggedCount := map[string]int{"alice": 0, "bob": 0}
	for _, c := range chunks {
		if c.Type == stream.ChunkTypeDelta {
			if c.EmpID == "" {
				t.Errorf("delta chunk missing EmpID tag: %+v", c)
				continue
			}
			taggedCount[c.EmpID]++
		}
	}
	if taggedCount["alice"] != 2 || taggedCount["bob"] != 2 {
		t.Errorf("delta counts = %+v, want 2 each", taggedCount)
	}

	// Both employees must have been called (order isn't asserted —
	// concurrent dispatch).
	mu.Lock()
	defer mu.Unlock()
	seen := map[string]bool{}
	for _, id := range calls {
		seen[id] = true
	}
	if !seen["alice"] || !seen["bob"] {
		t.Errorf("dispatch calls = %v, want both alice and bob", calls)
	}
}

func TestRunChain_AdapterErrorEmitsErrorChunkAndContinues(t *testing.T) {
	failingAdapter := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		return nil, errors.New("boom")
	})
	okAdapter := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: "ok"})
		return &harness.Result{Text: "ok"}, nil
	})

	runner := &Runner{
		// alice's model has codex/ prefix → routed to codex adapter.
		Adapters: map[string]Adapter{
			AdapterCodex:     failingAdapter,
			AdapterDirectAPI: okAdapter,
		},
		Employees: mapLoader{
			"alice": {ID: "alice", DefaultModel: "codex/gpt-5"},
			"bob":   {ID: "bob"},
		},
		Now: func() time.Time { return time.Unix(1700000000, 0) },
	}

	var chunks []stream.Chunk
	emit := ChunkEmitter(func(c stream.Chunk) {
		chunks = append(chunks, c)
	})
	res, err := runner.RunChain(context.Background(), []string{"alice", "bob"}, "sequential", Request{SessionID: "sid-err"}, emit)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	if len(res.PerEmployee) != 2 {
		t.Fatalf("PerEmployee len = %d", len(res.PerEmployee))
	}
	if res.PerEmployee[0].Err == nil {
		t.Errorf("alice should have errored")
	}
	if res.PerEmployee[1].Err != nil || res.PerEmployee[1].Text != "ok" {
		t.Errorf("bob should have succeeded: %+v", res.PerEmployee[1])
	}

	// Error chunk for alice somewhere in the stream.
	sawErr := false
	for _, c := range chunks {
		if c.Type == stream.ChunkTypeError && strings.Contains(c.Error, "boom") {
			sawErr = true
			break
		}
	}
	if !sawErr {
		t.Errorf("expected error chunk for alice; chunks = %+v", chunks)
	}
}

func TestRunChain_AdapterRoutingByPartnerType(t *testing.T) {
	var got atomic.Value
	got.Store("")

	makeAdapter := func(label string) Adapter {
		return func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
			got.Store(label)
			return &harness.Result{}, nil
		}
	}

	cases := []struct {
		name     string
		rec      *EmployeeRecord
		base     Request
		wantAdpt string
	}{
		{"openclaw-partner", &EmployeeRecord{ID: "oc", PartnerType: "openclaw"}, Request{}, AdapterOpenClaw},
		{"hermes-partner", &EmployeeRecord{ID: "hx", PartnerType: "hermes"}, Request{}, AdapterHermes},
		{"codex-model-prefix", &EmployeeRecord{ID: "e1", DefaultModel: "codex/gpt-5"}, Request{}, AdapterCodex},
		{"codex-instance-hint", &EmployeeRecord{ID: "e2"}, Request{CodexInstance: "default"}, AdapterCodex},
		{"claude-subscription", &EmployeeRecord{ID: "e3", DefaultModel: "claude-opus-4-7"}, Request{Provider: "Anthropic Subscription"}, AdapterClaudeBinary},
		{"harness-instance-hint", &EmployeeRecord{ID: "e4"}, Request{HarnessInstance: "claude-default"}, AdapterClaudeBinary},
		{"plain-api", &EmployeeRecord{ID: "e5", DefaultModel: "claude-opus-4-7"}, Request{}, AdapterDirectAPI},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got.Store("")
			runner := &Runner{
				Adapters: map[string]Adapter{
					AdapterOpenClaw:     makeAdapter(AdapterOpenClaw),
					AdapterHermes:       makeAdapter(AdapterHermes),
					AdapterCodex:        makeAdapter(AdapterCodex),
					AdapterClaudeBinary: makeAdapter(AdapterClaudeBinary),
					AdapterDirectAPI:    makeAdapter(AdapterDirectAPI),
				},
				Employees: mapLoader{tc.rec.ID: tc.rec},
				Now:       func() time.Time { return time.Unix(1700000000, 0) },
			}
			emit := ChunkEmitter(func(stream.Chunk) {})
			_, err := runner.RunChain(context.Background(), []string{tc.rec.ID}, "sequential", tc.base, emit)
			if err != nil {
				t.Fatalf("RunChain: %v", err)
			}
			if got.Load().(string) != tc.wantAdpt {
				t.Errorf("dispatched to %q, want %q", got.Load(), tc.wantAdpt)
			}
		})
	}
}

func TestRunChain_UnsupportedPartnerTypeYieldsErrorRow(t *testing.T) {
	runner := &Runner{
		Adapters:  map[string]Adapter{},
		Employees: mapLoader{"weird": {ID: "weird", PartnerType: "experimental-x"}},
		Now:       func() time.Time { return time.Unix(1700000000, 0) },
	}
	res, err := runner.RunChain(context.Background(), []string{"weird"}, "sequential", Request{}, nil)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	if len(res.PerEmployee) != 1 || res.PerEmployee[0].Err == nil {
		t.Fatalf("expected per-employee err row, got %+v", res.PerEmployee)
	}
	if !strings.Contains(res.PerEmployee[0].Err.Error(), "unsupported partner type") {
		t.Errorf("err = %v, want unsupported partner type", res.PerEmployee[0].Err)
	}
}

func TestRunChain_MissingAdapterYieldsErrorRow(t *testing.T) {
	runner := &Runner{
		Adapters:  map[string]Adapter{}, // empty — nothing registered
		Employees: mapLoader{"alice": {ID: "alice"}},
	}
	res, err := runner.RunChain(context.Background(), []string{"alice"}, "sequential", Request{}, nil)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	if len(res.PerEmployee) != 1 || res.PerEmployee[0].Err == nil {
		t.Fatalf("expected err row, got %+v", res.PerEmployee)
	}
	if !strings.Contains(res.PerEmployee[0].Err.Error(), "no adapter registered") {
		t.Errorf("err = %v, want no-adapter error", res.PerEmployee[0].Err)
	}
}

func TestRunChain_NoEmployeesIsNoOp(t *testing.T) {
	runner := &Runner{
		Employees: mapLoader{},
		Adapters:  map[string]Adapter{},
	}
	res, err := runner.RunChain(context.Background(), []string{"missing"}, "sequential", Request{}, nil)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	if len(res.PerEmployee) != 0 {
		t.Errorf("PerEmployee = %+v, want empty", res.PerEmployee)
	}
}

func TestRunChain_PersistCalledForEachSuccessfulEmployee(t *testing.T) {
	var (
		mu    sync.Mutex
		calls []string
		saves []PersistBroadcastPayload
		muSav sync.Mutex
	)
	adapter := func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		mu.Lock()
		calls = append(calls, req.BroadcastEmp.ID)
		mu.Unlock()
		text := "reply-" + req.BroadcastEmp.ID
		emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: text})
		return &harness.Result{
			Text:       text,
			StopReason: "end_turn",
			Usage:      harness.Usage{InputTokens: 12, OutputTokens: 34},
		}, nil
	}

	runner := &Runner{
		Adapters: map[string]Adapter{AdapterDirectAPI: adapter},
		Employees: mapLoader{
			"alice": {ID: "alice", Name: "Alice", Role: "Engineer", SymbolColor: "#ff00aa", DefaultModel: "claude-opus-4-7"},
			"bob":   {ID: "bob", Name: "Bob", Role: "Designer", SymbolColor: "#00ffaa", DefaultModel: "claude-opus-4-7"},
		},
		Now: func() time.Time { return time.Unix(1700000000, 0) },
		Persist: func(ctx context.Context, payload PersistBroadcastPayload) {
			muSav.Lock()
			defer muSav.Unlock()
			saves = append(saves, payload)
		},
	}

	emit := ChunkEmitter(func(stream.Chunk) {})
	_, err := runner.RunChain(context.Background(), []string{"alice", "bob"}, "sequential", Request{
		SessionID: "sid-bc",
		Input:     "hi",
		Model:     "claude-opus-4-7",
	}, emit)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}

	muSav.Lock()
	defer muSav.Unlock()
	if len(saves) != 2 {
		t.Fatalf("Persist called %d times, want 2: %+v", len(saves), saves)
	}
	// Sequential dispatch order: alice first, bob second.
	if saves[0].EmployeeID != "alice" || saves[1].EmployeeID != "bob" {
		t.Errorf("Persist order = [%s, %s], want [alice, bob]", saves[0].EmployeeID, saves[1].EmployeeID)
	}
	if saves[0].SessionID != "sid-bc" {
		t.Errorf("SessionID = %q", saves[0].SessionID)
	}
	if saves[0].Text != "reply-alice" || saves[1].Text != "reply-bob" {
		t.Errorf("Text mismatch: [%q, %q]", saves[0].Text, saves[1].Text)
	}
	if saves[0].Author == nil || saves[0].Author.Name != "Alice" || saves[0].Author.Role != "Engineer" || saves[0].Author.SymbolColor != "#ff00aa" {
		t.Errorf("Author block = %+v", saves[0].Author)
	}
	if saves[0].Model != "claude-opus-4-7" {
		t.Errorf("Model = %q", saves[0].Model)
	}
	if saves[0].InputTokens != 12 || saves[0].OutputTokens != 34 {
		t.Errorf("token counts = (%d, %d)", saves[0].InputTokens, saves[0].OutputTokens)
	}
	if saves[0].StopReason != "end_turn" {
		t.Errorf("StopReason = %q", saves[0].StopReason)
	}
}

func TestRunChain_PersistSkippedOnAdapterError(t *testing.T) {
	var (
		muSav sync.Mutex
		saves []PersistBroadcastPayload
	)
	failing := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		return nil, errors.New("boom")
	})
	ok := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		return &harness.Result{Text: "ok"}, nil
	})
	runner := &Runner{
		Adapters: map[string]Adapter{
			AdapterCodex:     failing,
			AdapterDirectAPI: ok,
		},
		Employees: mapLoader{
			"alice": {ID: "alice", DefaultModel: "codex/gpt-5"},
			"bob":   {ID: "bob"},
		},
		Now: func() time.Time { return time.Unix(1700000000, 0) },
		Persist: func(ctx context.Context, payload PersistBroadcastPayload) {
			muSav.Lock()
			defer muSav.Unlock()
			saves = append(saves, payload)
		},
	}
	_, err := runner.RunChain(context.Background(), []string{"alice", "bob"}, "sequential", Request{SessionID: "sid-x"}, nil)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	muSav.Lock()
	defer muSav.Unlock()
	if len(saves) != 1 {
		t.Fatalf("Persist called %d times, want 1: %+v", len(saves), saves)
	}
	if saves[0].EmployeeID != "bob" {
		t.Errorf("Persist fired for %q, want bob only", saves[0].EmployeeID)
	}
}

func TestRunChain_PersistNilIsNoOp(t *testing.T) {
	// Default zero-value Runner: Persist is nil. The runner must not
	// panic and must complete the chain normally.
	runner := &Runner{
		Adapters: map[string]Adapter{
			AdapterDirectAPI: func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
				return &harness.Result{Text: "ok"}, nil
			},
		},
		Employees: mapLoader{"alice": {ID: "alice"}},
		Now:       func() time.Time { return time.Unix(1700000000, 0) },
	}
	res, err := runner.RunChain(context.Background(), []string{"alice"}, "sequential", Request{SessionID: "sid-noop"}, nil)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	if len(res.PerEmployee) != 1 || res.PerEmployee[0].Err != nil || res.PerEmployee[0].Text != "ok" {
		t.Errorf("PerEmployee = %+v", res.PerEmployee)
	}
}

func TestRunChain_PersistSkippedOnEmptyText(t *testing.T) {
	var (
		muSav sync.Mutex
		saves []PersistBroadcastPayload
	)
	silent := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		return &harness.Result{Text: ""}, nil
	})
	runner := &Runner{
		Adapters:  map[string]Adapter{AdapterDirectAPI: silent},
		Employees: mapLoader{"alice": {ID: "alice"}},
		Now:       func() time.Time { return time.Unix(1700000000, 0) },
		Persist: func(ctx context.Context, payload PersistBroadcastPayload) {
			muSav.Lock()
			defer muSav.Unlock()
			saves = append(saves, payload)
		},
	}
	_, err := runner.RunChain(context.Background(), []string{"alice"}, "sequential", Request{SessionID: "sid-silent"}, nil)
	if err != nil {
		t.Fatalf("RunChain: %v", err)
	}
	muSav.Lock()
	defer muSav.Unlock()
	if len(saves) != 0 {
		t.Errorf("Persist fired for empty-text reply: %+v", saves)
	}
}

func TestComposePreset(t *testing.T) {
	got := ComposePreset("Base text", "id-note", "important-block", "cwd-block")
	want := "Base text\n\nid-note\n\nimportant-block\n\ncwd-block"
	if got != want {
		t.Errorf("ComposePreset = %q, want %q", got, want)
	}
	// Empty fragments are skipped.
	if ComposePreset("", "id", "", "") != "id" {
		t.Errorf("ComposePreset empty-fragments handling broken")
	}
}

func TestEffectiveModelAndSystemMode(t *testing.T) {
	rec := &EmployeeRecord{DefaultModel: "claude-opus-4-7"}
	if got := EffectiveModel(rec, "fallback"); got != "claude-opus-4-7" {
		t.Errorf("EffectiveModel emp-priority = %q", got)
	}
	if got := EffectiveModel(&EmployeeRecord{}, "fallback"); got != "fallback" {
		t.Errorf("EffectiveModel fallback = %q", got)
	}
	if got := EffectiveSystemMode(""); got != "replace" {
		t.Errorf("EffectiveSystemMode default = %q, want replace", got)
	}
	if got := EffectiveSystemMode("append"); got != "append" {
		t.Errorf("EffectiveSystemMode pass-through = %q", got)
	}
}

func TestAllowedToolsForEmployee(t *testing.T) {
	preset := []string{"bash", "read", "write"}

	if got := AllowedToolsForEmployee(&EmployeeRecord{CapTools: "off"}, preset); got == nil || len(got) != 0 {
		t.Errorf("capTools off = %v, want empty slice", got)
	}
	if got := AllowedToolsForEmployee(&EmployeeRecord{CapTools: "on", ToolSetPreset: "x"}, preset); got != nil {
		t.Errorf("capTools on = %v, want nil (full catalog)", got)
	}
	if got := AllowedToolsForEmployee(&EmployeeRecord{ToolSetPreset: "x"}, preset); len(got) != len(preset) {
		t.Errorf("preset-narrowed list = %v, want %v", got, preset)
	}
	if got := AllowedToolsForEmployee(&EmployeeRecord{}, preset); got != nil {
		t.Errorf("no preset → %v, want nil", got)
	}
}

func TestImagesForEmployeeRespectsCapVisionOff(t *testing.T) {
	imgs := []harness.ImageBlock{{MediaType: "image/png", Base64: "AAA"}}
	if got := ImagesForEmployee(&EmployeeRecord{CapVision: "off"}, imgs); got != nil {
		t.Errorf("capVision off = %v, want nil", got)
	}
	if got := ImagesForEmployee(&EmployeeRecord{}, imgs); len(got) != 1 {
		t.Errorf("default passthrough len = %d, want 1", len(got))
	}
}

func TestIdentityNoteHandlesEmpty(t *testing.T) {
	if IdentityNote("") != "" {
		t.Errorf("empty name should yield empty note")
	}
	note := IdentityNote("Alice")
	if !strings.Contains(note, "Alice") {
		t.Errorf("IdentityNote(%q) = %q, want it to contain the name", "Alice", note)
	}
}
