import { useEffect, useRef } from 'react';
import { renderMetaSection } from './meta-section.js';

// Skills tab — every skill in YHA is a meta-skill (SKILL.md in
// bridge/modules/skills-editor/skills/<name>/). Categories declared in
// each skill's frontmatter group related skills together for readability;
// the per-row `mounted` checkbox is what actually controls whether a
// skill is available in chat. The whole tab is one list — there is no
// longer a separate "skills" vs. "skill sets" split.

export function TabSkills() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hostRef.current) renderMetaSection(hostRef.current, 'skill');
  }, []);

  return (
    <>
      <p className="dim" style={{ fontSize: 11, margin: '0 0 8px' }}>
        Skills are SKILL.md files that give the model detailed instructions for orchestrating tools and MCP servers. Each one declares a <code>category:</code> in its frontmatter — categories are purely a visual grouping here.
      </p>
      <p className="dim" style={{ fontSize: 11, margin: '0 0 12px' }}>
        Invoke a skill in chat with <code>#skill-&lt;name&gt;</code> — it lives on the <strong>#</strong> picker (commands that produce direct chat output) alongside tools and MCP. The <strong>/</strong> palette is reserved for interface, settings, and module commands that don&rsquo;t enter the chat stream. Use the per-row <strong>mounted</strong> checkbox to pick which skills are available in chat.
      </p>
      <div ref={hostRef} />
    </>
  );
}
