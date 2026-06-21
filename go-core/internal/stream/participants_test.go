package stream

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileParticipantResolverMentionOpenClaw(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "sessions", "sid-1.json"), `{"participants":["oc-1","emp-1"],"groupMode":"sequential"}`+"\n")
	mustWriteFile(t, filepath.Join(root, "employees", "emp-1.md"), "---\nid: emp-1\nname: Alice\n---\n")
	mustWriteFile(t, filepath.Join(root, "partners.json"), `[
  {"id":"oc-1","type":"openclaw","name":"Claw","enabled":true},
  {"id":"hx-1","type":"hermes","name":"Hermes","enabled":true}
]`+"\n")

	resolver := NewFileParticipantResolver(root)
	ctx, err := resolver.Resolve("sid-1", "@Claw investigate this")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ctx.HasParticipants || !ctx.ViaMention {
		t.Fatalf("unexpected context: %+v", ctx)
	}
	if ctx.Target == nil || ctx.Target.PartnerType != "openclaw" || ctx.Target.PartnerID != "oc-1" {
		t.Fatalf("target = %+v, want openclaw oc-1", ctx.Target)
	}
	if ctx.Input != "investigate this" {
		t.Fatalf("clean input = %q, want trimmed mention-free text", ctx.Input)
	}
}

func TestFileParticipantResolverModerator(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "sessions", "sid-2.json"), `{"participants":["emp-1","emp-2"],"groupMode":"moderator"}`+"\n")
	mustWriteFile(t, filepath.Join(root, "employees", "emp-1.md"), "---\nid: emp-1\nname: Mod\n---\n")
	mustWriteFile(t, filepath.Join(root, "employees", "emp-2.md"), "---\nid: emp-2\nname: Bob\n---\n")

	resolver := NewFileParticipantResolver(root)
	ctx, err := resolver.Resolve("sid-2", "hello team")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ctx.HasParticipants || ctx.GroupMode != "moderator" || ctx.Broadcast {
		t.Fatalf("unexpected context: %+v", ctx)
	}
	if ctx.Target == nil || ctx.Target.ID != "emp-1" {
		t.Fatalf("target = %+v, want first participant", ctx.Target)
	}
}

func TestFileParticipantResolverSingleSequentialBroadcast(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "sessions", "sid-3.json"), `{"participants":["emp-1"],"groupMode":"sequential"}`+"\n")
	mustWriteFile(t, filepath.Join(root, "employees", "emp-1.md"), "---\nid: emp-1\nname: Solo\n---\n")

	resolver := NewFileParticipantResolver(root)
	ctx, err := resolver.Resolve("sid-3", "hello")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ctx.HasParticipants || !ctx.Broadcast {
		t.Fatalf("unexpected context: %+v", ctx)
	}
	if ctx.Target == nil || ctx.Target.ID != "emp-1" {
		t.Fatalf("target = %+v, want single participant", ctx.Target)
	}
}

func mustWriteFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
}
