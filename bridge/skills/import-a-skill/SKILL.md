---
name: import-a-skill
category: meta
description: Import an external skill (HermesHub, GitHub repo, or local path) into YHA so it lands in the shared definitions dir with the right per-user data wiring. Use when the user wants to add, install, or pull in a skill from outside YHA.
---

# Import a skill into YHA

YHA splits skills into two locations on purpose. Imported skills must respect the split or they leak user-specific paths into the shared definition and break for the next user.

## The two locations

| Kind | Location | Owned by | Use for |
|------|----------|----------|---------|
| **Definitions** (shared) | `bridge/skills/<name>/` | Repo (git-tracked) | `SKILL.md`, `scripts/`, `references/` — everything that's the same for every user |
| **Data** (per-user) | `bridge/users/<email>/skills-data/<name>/` | Per-user, gitignored | OAuth tokens, refresh tokens, client_secret.json, OAuth pending state, anything the user authenticates against once |
| **Scratch / tmp** (per-user) | `bridge/users/<email>/tmp/` | Per-user, gitignored | Handoff documents, intermediate files, anything you'd otherwise `mktemp` |

## Env vars the bridge sets at boot

These are exported into `process.env` by `bridge/core/paths.ts` and inherited by every subprocess the bridge spawns (Python sandboxes, bash scripts, MCP children).

- `YHA_USER_DIR` → `bridge/users/<email>/`
- `YHA_USER_TMP` → `bridge/users/<email>/tmp/`  *(replaces `mktemp -t …`)*
- `YHA_USER_SKILLS_DATA` → `bridge/users/<email>/skills-data/` *(skill state goes under `<this>/<skill-name>/`)*
- `YHA_SHARED_SKILLS_DIR` → `bridge/skills/`

When you write a SKILL.md or skill script, **reference these env vars** instead of absolute paths. The bridge will resolve them at execution time.

## Steps to import a skill

### 1. Get the source

Three common sources:

- **HermesHub** (HermesHub.org GitHub mirror) — `mcp_skills-editor.install_hermeshub_skill {name: "<skill>"}`
- **Any GitHub repo** — `mcp_skills-editor.install_github_skill {repo: "owner/name", branch: "main", basePath: "skills", skill: "<name>"}`
- **Local path** — `mcp_skills-editor.import_skill_from_path {sourcePath: "/abs/path/to/skill-dir"}`

All three call into `bridge/modules/skills-editor/lib.js`. The skill is copied into `bridge/skills/<name>/` and `normalizeImportedSkill` runs to rewrite Hermes-isms into YHA-isms.

### 2. Verify the layout

After the import completes, check:

```bash
ls bridge/skills/<name>/
# Expect: SKILL.md, .yha-import.json, optionally scripts/, references/

ls "$YHA_USER_SKILLS_DATA/<name>/" 2>/dev/null || echo "no data yet — created on first use"
```

If the skill ships any scripts that read/write state, they should use the helper at `scripts/_yha_paths.py` (or `_hermes_home.py` for legacy-named imports) — the normalizer wires `YHA_USER_SKILLS_DATA` into that helper automatically.

### 3. Patch SKILL.md if it hardcodes paths

Some upstream skills assume a `~/.hermes/`-style state dir. After import, grep the SKILL.md for absolute paths and replace with env-var references:

| Replace this | With this |
|--------------|-----------|
| `~/.hermes/<skill>/<file>` | `$YHA_USER_SKILLS_DATA/<skill>/<file>` |
| `bridge/meta/skills/<skill>` | `bridge/skills/<skill>` |
| `mktemp -t foo-XXXXXX.md` | `mktemp -p "${YHA_USER_TMP:-${TMPDIR:-/tmp}}" foo-XXXXXX.md` |
| `/tmp/<skill>-…` | `$YHA_USER_TMP/<skill>-…` |

### 4. Verify the skill loads

```bash
# From the bridge, list skills — your import should appear:
# (or via the UI: skills-editor module)
```

Then ask the user to try the skill and report any path errors.

## Authoring a skill from scratch?

Use the `write-a-skill` skill instead. It generates a skeleton that already follows this convention.

## When to override the split

The split is the default. The only reason to author a skill that writes inside its own shared dir is if the file genuinely is the same across every user (e.g. a cached reference document the skill ships pre-rendered). For anything the user authenticates against, anything they configure, or anything that varies per machine, write to `$YHA_USER_SKILLS_DATA/<name>/`.
