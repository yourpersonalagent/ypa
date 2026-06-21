---
name: cwd-plugin-creator
category: yha
description: "Scaffold a new YHA visual plugin for the current working directory. Writes .yha-plugins/<slug>/{plugin.json, tiles/<id>/{tile.json, data.ts?}} after a short clarifying conversation. Declarative-first: plugins normally pick a built-in widget template and (optionally) a server-side data.ts loader. The legacy sandboxed-iframe path is available as an explicit escape hatch."
version: 2.0.0
metadata:
  hermes:
    tags: [YHA, plugins, scaffolding, cwd, frontend]
---

# CWD plugin creator

You are scaffolding a new YHA visual plugin that will live in the user's current working directory. Plugins are folders under `<cwd>/.yha-plugins/<plugin>/` that contribute **tiles** rendered in the YHA header dropdown, the App Command Palette, and (when `inlineSupported: true`) inline in chat.

YHA renders tiles in **two trust modes**:

- **`trust: "declarative"` (default, recommended)** — the tile's `tile.json` declares a built-in widget `template` and (optionally) a server-side `data.ts` loader. There is no plugin code in the browser. The host renders the widget with full theme integration; the bridge runs `data.ts` and returns JSON to the host. Use this for ~all tiles.
- **`trust: "sandboxed"` (escape hatch)** — the tile ships an `index.html` rendered in a sandboxed iframe (`allow-scripts`, opaque origin). Use only when a tile genuinely needs custom DOM (interactive charts, maps, etc).

## When this skill is invoked

The user clicked the `+` in the YHA header (or typed `#skill-cwd-plugin-creator …` in the command picker). Any trailing content is the user's seed idea — treat it as the first answer to "what should this tile do?". If empty, ask.

The host has guaranteed a CWD is active. Read it from the conversation context or with `pwd`.

## Disk layout

```
<cwd>/.yha-plugins/<plugin>/
├── plugin.json
└── tiles/
    └── <tile>/
        ├── tile.json
        ├── data.ts          (optional — only if the tile needs local data)
        └── index.html       (only if trust: "sandboxed")
```

- `<plugin>` and `<tile>` are slugs: `^[a-z0-9][a-z0-9_-]{0,63}$`. The folder name is authoritative — the scanner overrides any mismatched `name`/`id` in JSON.

### `plugin.json` schema

```jsonc
{
  "name": "<plugin-slug>",   // required, must equal folder name
  "label": "<Human Label>",   // required
  "version": "0.1.0",
  "icon": "sparkles"          // lucide-react icon name
}
```

### `tile.json` — declarative (default)

```jsonc
{
  "id": "<tile-slug>",        // required, must equal folder name
  "label": "<Human Label>",    // required
  "template": "list",          // required — one of: headline | kv | list | table
  "data": "data.ts",           // optional — bridge-side loader filename
  "props": { /* widget-specific config */ },
  "refresh": { "interval": 30 }, // or "manual" (default)
  "size": { "w": 320, "h": 360 },
  "headline": { "from": "headline" },   // hooks a key from data into the rotator
  "command": { "keywords": ["git","commits"] },
  "inlineSupported": false
}
```

### `tile.json` — sandboxed (rare)

```jsonc
{
  "id": "<tile-slug>",
  "label": "<Human Label>",
  "trust": "sandboxed",
  "entry": "index.html",
  "size": { "w": 320, "h": 180 }
}
```

## Widget templates (built-in)

Pick the simplest one that fits. Each is themed by the host's CSS variables, so it looks native automatically.

| Template | Shape | Typical `props` |
|---|---|---|
| `headline` | One big value + optional unit + trend arrow | `{ title?, valuePath, labelPath?, trendPath? }` |
| `kv` | Two-column key/value list | `{ title?, dataPath?, pairs?: [{key, valuePath}] }` |
| `list` | Vertical rows with primary/secondary/trailing slots | `{ title?, dataPath?, itemTemplate: { primary, secondary?, trailing? }, onClick? }` |
| `table` | Compact table | `{ title?, dataPath?, columns: [{ header, valuePath | template, align? }], onClick? }` |

Templates use a tiny mustache subset: `{{path.to.value}}` only. No `{{#if}}`, no `{{#each}}` — the widget's structure provides iteration. If you need conditionals, you're using the wrong template.

### Row actions (`onClick`)

`list` and `table` accept an `onClick` action. Two safe shapes:

- `{ "type": "openUrl", "href": "{{templated.url}}" }` — opens in a new tab.
- `{ "type": "command", "name": "<group.id>" }` — runs an app-command (palette entry).

## `data.ts` contract

Lives next to `tile.json`. Default export an async function:

```ts
export default async function load(ctx: {
  cwd: string;                                          // absolute, already resolved
  query: Record<string, string>;                         // from URL ?q.foo=bar
  exec: (
    cmd: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}): Promise<unknown> {
  // … return JSON-serializable data
}
```

Constraints:

- **No shell injection.** `exec` takes an argv array, not a string. Pass `["git", "log", ...]`, never a joined string.
- **10s timeout, 1 MiB stdout cap** per `exec` call. Tiles that need more should paginate or summarize.
- **Top-level imports allowed** (`fs`, `path`, etc). The loader runs in the bridge's Node/Bun process.
- **No secrets in committed files.** If the loader needs a token, read it from `process.env` or a CWD-local file outside the plugin folder.

### Trust gate

The first time a user activates a CWD whose plugins ship `data.ts`, the header dropdown shows a one-time prompt: *"Allow N data loaders for this CWD?"* — choice cached per-CWD in `localStorage`. The user can deny. **Set the user's expectation in your final hand-off: if they deny, the data tiles will render empty.**

## Conversation flow

1. **Clarify what the tile should do.** One short question. If the user seeded an idea, paraphrase and ask one specific follow-up (data source? refresh cadence? clickable rows?).
2. **Pick a template.** Map the user's idea to the closest built-in. If nothing fits cleanly, ask one more question instead of inventing a template — only fall back to `trust: "sandboxed"` if the user explicitly asks for custom rendering.
3. **Decide whether `data.ts` is needed.** Required for: anything reading the local filesystem, anything running shell commands, anything talking to a private API with credentials. Skipped for: tiles that need no data (static lookups, links).
4. **Propose slugs.** Kebab-case from the user's description. Confirm.
5. **Scaffold.** Use the Write tool. Always emit valid JSON. Manifests with malformed JSON are silently dropped by the scanner.
6. **Validate.** After writing, hit the bridge to confirm the manifest parses:
   ```bash
   curl -s "http://localhost:8442/v1/plugins?cwd=$(pwd)" | jq '.plugins, .errors'
   ```
   - Appearing in `.plugins` with the expected tile → success.
   - Appearing in `.errors` → manifest is malformed; fix and re-curl. Do NOT mark the work complete until clean.
   - If port `8442` isn't listening, check `pm2 status` or `.env` `PORT` (`8443` in node-only mode).
7. **Tell the user how to see it.** There is no manifest watcher yet — the frontend only re-scans on CWD change. Instruct: *"Re-select your current working directory in the YHA CWD picker (or refresh the browser) to pick up the new plugin. Click `+` in the header — your new tile will appear with a checkbox; tick it to render. If your tile uses `data.ts`, click **Allow** on the trust prompt the first time."*

## Hard rules

- **One plugin and one tile per invocation** unless the user asks for more. Resist scope creep.
- **Never modify files outside `<cwd>/.yha-plugins/<plugin>/`.** This skill scaffolds local plugins only — not bridge modules, not frontend modules.
- **Never use `inlineSupported: true` unless the tile renders well at ≤ 80 px tall.** It's a quality signal, not a default.
- **Never put secrets, API keys, or absolute paths into the scaffold.** Plugins live in git alongside the user's project.
- **Default to declarative.** Only use `trust: "sandboxed"` when the user has expressed a need that a built-in template cannot meet.

## Worked example — codebase stats

User asks: "show recent commits and the biggest files in this repo."

Plugin slug: `codebase-stats`. One tile, slug `overview`, template `list` for commits.

`.yha-plugins/codebase-stats/plugin.json`
```json
{ "name": "codebase-stats", "label": "Codebase stats", "version": "0.1.0", "icon": "git-commit" }
```

`.yha-plugins/codebase-stats/tiles/overview/tile.json`
```json
{
  "id": "overview",
  "label": "Recent commits",
  "template": "list",
  "data": "data.ts",
  "refresh": "manual",
  "size": { "w": 360, "h": 320 },
  "props": {
    "title": "Last 10 commits",
    "dataPath": "commits",
    "itemTemplate": {
      "primary": "{{subject}}",
      "secondary": "{{author}} · {{relDate}}",
      "trailing": "{{shortHash}}"
    }
  },
  "command": { "keywords": ["git","commits","log"] }
}
```

`.yha-plugins/codebase-stats/tiles/overview/data.ts`
```ts
export default async function load(ctx: {
  cwd: string;
  exec: (cmd: string[]) => Promise<{ stdout: string; code: number }>;
}) {
  const { stdout } = await ctx.exec([
    'git', '-C', ctx.cwd,
    'log', '-n', '10',
    "--pretty=format:%h\t%s\t%an\t%cr",
  ]);
  const commits = stdout.split('\n').filter(Boolean).map((line) => {
    const [shortHash, subject, author, relDate] = line.split('\t');
    return { shortHash, subject, author, relDate };
  });
  return { commits };
}
```

After writing, curl the manifest endpoint, confirm `codebase-stats` appears, then tell the user to re-pick the CWD, allow the trust prompt, and toggle the tile.

## Where the underlying code lives

Useful when debugging:

- Manifest schema + scanner: `bridge/modules/plugins-folder/scanner.ts`
- Data loader (route + hot-reload + exec wrapper): `bridge/modules/plugins-folder/data.ts` and `routes.ts`
- Asset server + CSP (sandboxed path): `bridge/modules/plugins-folder/assets.ts`
- Frontend loader: `frontend/src/modules/plugins-folder/index.ts`
- Renderer dispatch (declarative ↔ sandboxed): `frontend/src/modules/plugins-folder/components/TileRenderer.tsx`
- Widgets: `frontend/src/modules/plugins-folder/widgets/`
- Trust prompt UI: `frontend/src/modules/plugins-folder/components/PluginsDropdown.tsx`
- Reference declarative plugin: `.yha-plugins/codebase-stats/`
- Reference sandboxed plugin: `.yha-plugins/example/`
