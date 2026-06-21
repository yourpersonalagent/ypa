---
name: hermeshub
category: yha
description: Browse, inspect, install, and uninstall HermesHub skills through the YHA Meta Bridge. Use when the user wants skills from https://www.hermeshub.xyz/ or the amanning3390/hermeshub GitHub catalog.
---

# HermesHub

Use this skill when the user wants to work with the HermesHub catalog inside YHA.

## Workflow

1. Call `meta_list_hermeshub_skills` to browse the current catalog.
2. If the user asks about a specific skill, call `meta_get_hermeshub_skill` first and inspect its `SKILL.md` and file list.
3. Install with `meta_install_hermeshub_skill`.
4. Uninstall with `meta_delete_skill`.

## Install Rules

- Prefer the HermesHub name unchanged unless the user explicitly wants a local rename.
- HermesHub installs are normalized for YHA during import. That means the bridge rewrites obvious Hermes-specific paths and helper names into the local YHA meta-skill layout where possible.
- Keep real external names and URLs intact when they refer to upstream resources, such as `https://www.hermeshub.xyz/` or the `amanning3390/hermeshub` repo.

## Commands

- Browse: `meta_list_hermeshub_skills()`
- Inspect: `meta_get_hermeshub_skill({ "name": "google-workspace" })`
- Install: `meta_install_hermeshub_skill({ "name": "google-workspace" })`
- Install with local rename: `meta_install_hermeshub_skill({ "name": "google-workspace", "target_name": "google-workspace-alt" })`
- Uninstall: `meta_delete_skill({ "name": "google-workspace" })`

## Notes

- HermesHub is currently sourced from the GitHub catalog behind the site, not from scraping rendered HTML.
- If a skill already exists locally, delete it first before reinstalling.
