package broadcast

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileEmployeeLoader_EmployeeFrontmatter(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "employees", "emp-1.md"), "---\n"+
		"id: emp-1\n"+
		"name: Alice\n"+
		"role: Engineer\n"+
		"defaultModel: claude-opus-4-7\n"+
		"defaultModelProvider: Anthropic Subscription\n"+
		"systemPromptPreset: CEOdave\n"+
		"toolSetPreset: read-only\n"+
		"symbolColor: #ff00aa\n"+
		"capVision: off\n"+
		"capTools: filter\n"+
		"---\n\nignored body\n")

	loader := NewFileEmployeeLoader(root)
	rec, err := loader.Load("emp-1")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if rec == nil {
		t.Fatal("Load returned nil record")
	}
	if rec.ID != "emp-1" || rec.Name != "Alice" || rec.Role != "Engineer" {
		t.Errorf("identity mismatch: %+v", rec)
	}
	if rec.DefaultModel != "claude-opus-4-7" {
		t.Errorf("DefaultModel = %q", rec.DefaultModel)
	}
	if rec.DefaultModelProvider != "Anthropic Subscription" {
		t.Errorf("DefaultModelProvider = %q", rec.DefaultModelProvider)
	}
	if rec.SystemPromptPreset != "CEOdave" {
		t.Errorf("SystemPromptPreset = %q", rec.SystemPromptPreset)
	}
	if rec.ToolSetPreset != "read-only" {
		t.Errorf("ToolSetPreset = %q", rec.ToolSetPreset)
	}
	if rec.SymbolColor != "#ff00aa" {
		t.Errorf("SymbolColor = %q", rec.SymbolColor)
	}
	if rec.CapVision != "off" {
		t.Errorf("CapVision = %q", rec.CapVision)
	}
	if rec.CapTools != "filter" {
		t.Errorf("CapTools = %q", rec.CapTools)
	}
	if rec.PartnerType != "" || rec.PartnerID != "" {
		t.Errorf("partner fields unexpectedly set: %+v", rec)
	}
}

func TestFileEmployeeLoader_PartnerFallback(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "partners.json"), `[
  {"id":"oc-1","type":"openclaw","name":"Claw","symbolColor":"#e05c3a","enabled":true},
  {"id":"hx-1","type":"hermes","name":"Hermes","enabled":false}
]`+"\n")

	loader := NewFileEmployeeLoader(root)
	rec, err := loader.Load("oc-1")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if rec == nil {
		t.Fatal("expected partner record, got nil")
	}
	if rec.PartnerType != "openclaw" || rec.PartnerID != "oc-1" {
		t.Errorf("partner-type mismatch: %+v", rec)
	}
	if rec.Name != "Claw" || rec.SymbolColor != "#e05c3a" {
		t.Errorf("partner identity mismatch: %+v", rec)
	}
	if rec.DefaultModel != "" {
		t.Errorf("partner record should not carry a model id, got %q", rec.DefaultModel)
	}

	// Disabled partner → no record.
	rec, err = loader.Load("hx-1")
	if err != nil {
		t.Fatalf("Load disabled: %v", err)
	}
	if rec != nil {
		t.Errorf("disabled partner returned %+v, want nil", rec)
	}
}

func TestFileEmployeeLoader_MissingID(t *testing.T) {
	root := t.TempDir()
	loader := NewFileEmployeeLoader(root)
	rec, err := loader.Load("nope")
	if err != nil {
		t.Fatalf("Load missing: %v", err)
	}
	if rec != nil {
		t.Errorf("missing id returned %+v, want nil", rec)
	}
}

func TestFileEmployeeLoader_EmployeeWinsOverPartner(t *testing.T) {
	// If a partner id collides with an employee id, the employee
	// file wins (matches Node's resolveTargetAgent order).
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "employees", "shared.md"), "---\nid: shared\nname: EmpShared\n---\n")
	mustWrite(t, filepath.Join(root, "partners.json"), `[{"id":"shared","type":"openclaw","name":"PartnerShared","enabled":true}]`+"\n")
	loader := NewFileEmployeeLoader(root)
	rec, err := loader.Load("shared")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if rec == nil || rec.PartnerType != "" || rec.Name != "EmpShared" {
		t.Errorf("employee should win over partner; got %+v", rec)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
}
