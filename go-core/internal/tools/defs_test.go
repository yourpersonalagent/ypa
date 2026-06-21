package tools

import (
	"context"
	"testing"
)

func TestStaticToolsHasSix(t *testing.T) {
	got := StaticTools()
	if len(got) != 6 {
		t.Errorf("expected 6 static tools, got %d", len(got))
	}
	wantNames := map[string]bool{
		"Bash": false, "Read": false, "Write": false,
		"Glob": false, "Grep": false, "WebFetch": false,
	}
	for _, t2 := range got {
		if t2.Source != "bridge" {
			t.Errorf("tool %q has Source=%q, want 'bridge'", t2.Name, t2.Source)
		}
		if _, ok := wantNames[t2.Name]; !ok {
			t.Errorf("unexpected tool: %q", t2.Name)
			continue
		}
		wantNames[t2.Name] = true
	}
	for n, seen := range wantNames {
		if !seen {
			t.Errorf("missing static tool: %q", n)
		}
	}
}

func TestBuildCatalogStaticOnly(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	got := BuildCatalog(e, nil, nil)
	if len(got) != 6 {
		t.Errorf("expected 6 entries, got %d", len(got))
	}
}

func TestBuildCatalogMergesMCP(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	servers := []MCPServer{
		{Name: "ws", Tools: []MCPTool{{Name: "search"}}},
	}
	got := BuildCatalog(e, servers, nil)
	if len(got) != 7 {
		t.Errorf("expected 7 entries (6 static + 1 mcp), got %d", len(got))
	}
	var found bool
	for _, t2 := range got {
		if t2.Name == "search" && t2.Source == "mcp:ws" {
			found = true
		}
	}
	if !found {
		t.Error("expected mcp tool 'search' with Source=mcp:ws")
	}
}

func TestBuildCatalogNamespacesCollisions(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	servers := []MCPServer{
		{Name: "alpha", Tools: []MCPTool{{Name: "ping"}}},
		{Name: "beta-server", Tools: []MCPTool{{Name: "ping"}}},
	}
	got := BuildCatalog(e, servers, nil)
	names := map[string]bool{}
	for _, t2 := range got {
		names[t2.Name] = true
	}
	if !names["alpha__ping"] || !names["beta_server__ping"] {
		t.Errorf("expected namespaced colliding names, got %v", names)
	}
}

func TestBuildCatalogFilter(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	got := BuildCatalog(e, nil, []string{"Read", "Write"})
	if len(got) != 2 {
		t.Errorf("expected 2 entries after filter, got %d", len(got))
	}
}

func TestExecutorTools(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	if len(e.Tools()) == 0 {
		t.Error("Tools() returned empty")
	}
}

func TestExecutorRunUnknownTool(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	res, err := e.Run(context.Background(), "Frobnicate", map[string]any{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.OK {
		t.Error("expected OK=false on unknown tool")
	}
}
