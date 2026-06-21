package stream

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// SkillBlock is one resolved skill ready to be folded into a prompt or
// passed to a harness adapter (claudebinary.Skill has the same shape).
// Mirrors Node's resolveSkills return value at
// bridge/chat/helpers.ts:105-119.
type SkillBlock struct {
	Name    string
	Content string
}

// ResolveSkillSet returns the markdown body of every skill named in
// config.skillSets[name]. skillsDir is typically bridge/skills (next
// to config.json). Missing files / unknown sets degrade silently —
// same behaviour as Node, which catches read errors per-skill and
// continues.
//
// When setName isn't a key in skillSets we treat it as a single
// skill name — matches the one-off palette-pick behaviour in
// helpers.ts:resolveSkills.
//
// Each member is resolved against the legacy config-skills dir first,
// then against the meta-bridge layout at
// bridge/modules/skills-editor/skills/<name>/SKILL.md.
//
// Filename sanitisation mirrors helpers.ts — anything outside
// [a-zA-Z0-9_\-. ] gets replaced with "_" so a malicious set entry
// can't traverse paths. The YAML frontmatter (leading `---` block) is
// stripped to match the TS behaviour.
func ResolveSkillSet(skillsDir, setName string, skillSets map[string][]string) []SkillBlock {
	setName = strings.TrimSpace(setName)
	if setName == "" || skillsDir == "" {
		return nil
	}
	var names []string
	if existing, ok := skillSets[setName]; ok && len(existing) > 0 {
		names = existing
	} else {
		names = []string{setName}
	}
	metaDir := filepath.Join(filepath.Dir(skillsDir), "modules", "skills-editor", "skills")
	out := make([]SkillBlock, 0, len(names))
	for _, sname := range names {
		sanitised := skillNameSanitiser.ReplaceAllString(sname, "_")
		var content string
		// 1. Legacy flat config-skill: <skillsDir>/<name>.md
		if data, err := os.ReadFile(filepath.Join(skillsDir, sanitised+".md")); err == nil {
			content = stripYAMLFrontmatter(string(data))
		} else if data, err := os.ReadFile(filepath.Join(metaDir, sanitised, "SKILL.md")); err == nil {
			// 2. Meta-bridge skill: <metaDir>/<name>/SKILL.md
			content = stripYAMLFrontmatter(string(data))
		} else {
			continue
		}
		out = append(out, SkillBlock{
			Name:    sname,
			Content: strings.TrimSpace(content),
		})
	}
	return out
}

// skillNameSanitiser keeps the same character class as the TS regex
// `[^a-zA-Z0-9_\-. ]`. Anything else becomes "_".
var skillNameSanitiser = regexp.MustCompile(`[^a-zA-Z0-9_\-. ]`)

// stripYAMLFrontmatter peels a leading "---\n...\n---\n" block off a
// markdown skill file. Matches the TS regex `^---[\s\S]*?---\n?`. Used
// so the skill body the model sees doesn't include the metadata
// header.
func stripYAMLFrontmatter(s string) string {
	if !strings.HasPrefix(s, "---") {
		return s
	}
	// Find the closing "---" after the first one.
	rest := s[3:]
	idx := strings.Index(rest, "---")
	if idx < 0 {
		return s
	}
	end := 3 + idx + 3
	if end < len(s) && s[end] == '\n' {
		end++
	}
	return s[end:]
}
