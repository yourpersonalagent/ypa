"""Resolve the local state directory for google-workspace skill scripts.

Skill definitions live in ``bridge/skills/<name>/`` (shared, git-tracked) and
their per-user runtime state lives under ``$YHA_USER_SKILLS_DATA/<name>/``
(set by the bridge at boot via ``core/paths.ts``). This module preserves the
legacy ``HERMES_HOME`` helper names for compatibility while resolving against
the new user-scoped data location.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_SCRIPT_PATH = Path(__file__).resolve()
_SKILL_DIR = _SCRIPT_PATH.parent.parent
_SKILL_NAME = _SKILL_DIR.name
_IMPORT_META_PATH = _SKILL_DIR / ".yha-import.json"
_LEGACY_DEFAULT_STATE_DIR = _SKILL_DIR / ".yha-state"


def _state_dir_from_import_metadata() -> Path | None:
    try:
        data = json.loads(_IMPORT_META_PATH.read_text())
    except Exception:
        return None
    raw = str(data.get("stateDir") or "").strip()
    return Path(raw).expanduser() if raw else None


def get_hermes_home() -> Path:
    """Return the skill state directory.

    Override order:
    1. ``YHA_GOOGLE_WORKSPACE_HOME`` (skill-specific override)
    2. ``$YHA_USER_SKILLS_DATA/<skill-name>/`` (universal per-user data root,
       set by the bridge at boot)
    3. imported skill metadata ``stateDir`` (back-compat for older imports)
    4. sibling ``.yha-state/`` (back-compat for legacy in-skill data)
    5. legacy ``HERMES_HOME`` / ``~/.hermes``
    """
    explicit = os.environ.get("YHA_GOOGLE_WORKSPACE_HOME", "").strip()
    if explicit:
        path = Path(explicit).expanduser()
    else:
        data_root = os.environ.get("YHA_USER_SKILLS_DATA", "").strip()
        if data_root:
            path = Path(data_root).expanduser() / _SKILL_NAME
        else:
            meta_path = _state_dir_from_import_metadata()
            if meta_path is not None and meta_path.exists():
                path = meta_path
            elif _LEGACY_DEFAULT_STATE_DIR.exists():
                path = _LEGACY_DEFAULT_STATE_DIR
            else:
                legacy = os.environ.get("HERMES_HOME", "").strip()
                path = Path(legacy).expanduser() if legacy else _LEGACY_DEFAULT_STATE_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def display_hermes_home() -> str:
    """Return a user-friendly display string for the resolved state dir."""
    home = get_hermes_home()
    try:
        return "~/" + str(home.relative_to(Path.home()))
    except ValueError:
        return str(home)
