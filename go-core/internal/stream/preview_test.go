package stream

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeBridgeFiles drops the minimal set of bridge/ files the preview
// reads (important-memory.json, cwd-context-memory.json) into the given
// directory. Caller is responsible for cleanup via t.TempDir().
func writeBridgeFiles(t *testing.T, dir string, importantLines []string, cwdContext map[string][]string) {
	t.Helper()
	imp := map[string]any{"lines": importantLines}
	impBytes, _ := json.Marshal(imp)
	if err := os.WriteFile(filepath.Join(dir, "important-memory.json"), impBytes, 0o644); err != nil {
		t.Fatalf("write important: %v", err)
	}
	cwdShape := make(map[string]map[string]any, len(cwdContext))
	for k, lines := range cwdContext {
		cwdShape[k] = map[string]any{"lines": lines}
	}
	cwdBytes, _ := json.Marshal(cwdShape)
	if err := os.WriteFile(filepath.Join(dir, "cwd-context-memory.json"), cwdBytes, 0o644); err != nil {
		t.Fatalf("write cwd-context: %v", err)
	}
}

func TestBuildSystemPreview_AllSources(t *testing.T) {
	dir := t.TempDir()
	writeBridgeFiles(t, dir,
		[]string{"important one", "important two"},
		map[string][]string{
			dir: {"this folder uses python 3.11", "tests live in tests/"},
		},
	)

	deps := RouteDeps{
		BridgeRoot:          dir,
		SessionsDir:         dir,
		DefaultCWD:          dir,
		DefaultSystemPrompt: func() string { return "You are a helpful assistant." },
		ResolvePreset: func(nameOrText string) string {
			if nameOrText == "coding" {
				return "You write tidy, well-tested code."
			}
			return nameOrText
		},
		ResolveSkills: func(setName string) []SkillBlock {
			if setName == "review" {
				return []SkillBlock{
					{Name: "review", Content: "Focus on correctness first, style second."},
				}
			}
			return nil
		},
	}

	preview := BuildSystemPreview(deps, PreviewRequest{
		CWD:      dir,
		Preset:   "coding",
		SkillSet: "review",
	})

	if preview.CWD != dir {
		t.Fatalf("cwd: got %q want %q", preview.CWD, dir)
	}

	kinds := make(map[string]PreviewSource, len(preview.Sources))
	for _, s := range preview.Sources {
		kinds[s.Kind] = s
	}

	for _, want := range []string{"default-system", "preset", "important", "cwd-context", "cwd-constraint", "skills"} {
		if _, ok := kinds[want]; !ok {
			t.Errorf("missing source kind %q in preview", want)
		}
	}

	if got := kinds["default-system"].Text; got != "You are a helpful assistant." {
		t.Errorf("default-system text: got %q", got)
	}
	if got := kinds["preset"].Text; got != "You write tidy, well-tested code." {
		t.Errorf("preset text: got %q", got)
	}
	if !strings.Contains(kinds["important"].Text, "important one") {
		t.Errorf("important footer missing line: %q", kinds["important"].Text)
	}
	if !strings.Contains(kinds["cwd-context"].Text, "python 3.11") {
		t.Errorf("cwd-context missing line: %q", kinds["cwd-context"].Text)
	}
	if !strings.Contains(kinds["cwd-constraint"].Text, "WORKING DIRECTORY CONSTRAINT") {
		t.Errorf("cwd-constraint missing prefix: %q", kinds["cwd-constraint"].Text)
	}
	if !strings.Contains(kinds["skills"].Text, "## Skill: review") {
		t.Errorf("skills missing header: %q", kinds["skills"].Text)
	}

	if preview.Assembled == "" {
		t.Fatal("assembled is empty")
	}
	for _, want := range []string{"helpful assistant", "tidy", "important one", "python 3.11", "WORKING DIRECTORY CONSTRAINT", "Skill: review"} {
		if !strings.Contains(preview.Assembled, want) {
			t.Errorf("assembled missing %q\n---\n%s", want, preview.Assembled)
		}
	}
	if preview.TotalBytes != len(preview.Assembled) {
		t.Errorf("totalBytes mismatch: got %d want %d", preview.TotalBytes, len(preview.Assembled))
	}
}

func TestBuildSystemPreview_ReplaceModeDropsDefault(t *testing.T) {
	deps := RouteDeps{
		DefaultSystemPrompt: func() string { return "BIG DEFAULT" },
		ResolvePreset:       func(name string) string { return "tiny preset" },
	}
	preview := BuildSystemPreview(deps, PreviewRequest{
		Preset:     "x",
		SystemMode: "replace",
	})
	for _, s := range preview.Sources {
		if s.Kind == "default-system" {
			t.Errorf("replace mode must drop default-system row, got %+v", s)
		}
	}
	if !strings.Contains(preview.Assembled, "tiny preset") {
		t.Errorf("preset missing from assembled: %q", preview.Assembled)
	}
	if strings.Contains(preview.Assembled, "BIG DEFAULT") {
		t.Errorf("replace mode leaked default: %q", preview.Assembled)
	}
}

func TestBuildSystemPreview_MultiplePresetNames(t *testing.T) {
	deps := RouteDeps{
		DefaultSystemPrompt: func() string { return "DEFAULT" },
		ResolvePreset: func(name string) string {
			switch name {
			case "coding":
				return "CODING PRESET"
			case "repo":
				return "REPO PRESET"
			default:
				return name
			}
		},
	}
	preview := BuildSystemPreview(deps, PreviewRequest{
		Preset:  "coding",
		Presets: []string{"coding", "repo"},
	})
	if !strings.Contains(preview.Assembled, "CODING PRESET") || !strings.Contains(preview.Assembled, "REPO PRESET") {
		t.Fatalf("multi-preset preview did not include both resolved presets: %q", preview.Assembled)
	}
}

func TestRegisterPreviewRoute_MethodAndShape(t *testing.T) {
	mux := http.NewServeMux()
	RegisterPreviewRoute(mux, RouteDeps{
		DefaultSystemPrompt: func() string { return "hi" },
	})

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/system-preview", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST should 405, got %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/system-preview", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("GET should 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("content-type: %q", ct)
	}
	var preview SystemPreview
	if err := json.Unmarshal(rr.Body.Bytes(), &preview); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, rr.Body.String())
	}
	if preview.Sources == nil {
		t.Errorf("sources is nil; expected at least default-system row")
	}
}
