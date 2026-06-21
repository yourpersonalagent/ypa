#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

from graphify.analyze import god_nodes, suggest_questions, surprising_connections
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.detect import detect
from graphify.export import to_html, to_json
from graphify.extract import collect_files, extract
from graphify.report import generate


def git_head(cwd: Path) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except Exception:
        return None
    head = proc.stdout.strip()
    return head or None


def resolve_targets(root: Path, target_arg: str | None) -> list[Path]:
    if not target_arg or target_arg.strip() in {"", "."}:
        found = detect(root)
        return [Path(p) for p in found.get("files", {}).get("code", [])]

    code_files: list[Path] = []
    seen: set[Path] = set()
    for raw in [part.strip() for part in target_arg.split(",") if part.strip()]:
        abs_target = (root / raw).resolve()
        try:
            abs_target.relative_to(root)
        except ValueError:
            continue
        if not abs_target.exists():
            continue
        if abs_target.is_file():
            candidates = [abs_target]
        else:
            candidates = collect_files(abs_target, root=root)
        for candidate in candidates:
            if candidate not in seen:
                seen.add(candidate)
                code_files.append(candidate)
    return sorted(code_files)


def resolve_doc_targets(root: Path, target_arg: str | None) -> list[Path]:
    """Find markdown/text/rst files to include as document nodes."""
    found = detect(root)
    all_docs = [Path(p) for p in found.get("files", {}).get("document", [])]

    if not target_arg or target_arg.strip() in {"", "."}:
        return sorted(all_docs)

    doc_files: list[Path] = []
    seen: set[Path] = set()
    for raw in [part.strip() for part in target_arg.split(",") if part.strip()]:
        abs_target = (root / raw).resolve()
        try:
            abs_target.relative_to(root)
        except ValueError:
            continue
        for f in all_docs:
            if f not in seen and str(f).startswith(str(abs_target)):
                seen.add(f)
                doc_files.append(f)
    return sorted(doc_files)


_HEADER_RE = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)


def _normalize_id(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def build_doc_nodes(doc_files: list[Path], root: Path) -> tuple[list[dict], list[dict]]:
    """Create deterministic document nodes from markdown/text files."""
    nodes: list[dict] = []
    links: list[dict] = []
    seen_ids: set[str] = set()

    def unique_id(base: str) -> str:
        _id = base[:200]
        n = 0
        while _id in seen_ids:
            n += 1
            _id = f"{base[:197]}_{n}"
        seen_ids.add(_id)
        return _id

    for f in doc_files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        rel = str(f.relative_to(root))
        file_id = unique_id(_normalize_id(rel))

        nodes.append(
            {
                "id": file_id,
                "label": f.name,
                "file_type": "document",
                "source_file": rel,
                "source_location": "L1",
                "source_url": None,
                "captured_at": None,
                "author": None,
                "contributor": None,
                "community": None,
            }
        )

        for m in list(_HEADER_RE.finditer(text))[:30]:
            header_text = m.group(2).strip()
            line_num = text[: m.start()].count("\n") + 1
            header_id = unique_id(f"{file_id}_{_normalize_id(header_text)}")
            nodes.append(
                {
                    "id": header_id,
                    "label": header_text,
                    "file_type": "document",
                    "source_file": rel,
                    "source_location": f"L{line_num}",
                    "source_url": None,
                    "captured_at": None,
                    "author": None,
                    "contributor": None,
                    "community": None,
                }
            )
            links.append(
                {
                    "source": file_id,
                    "target": header_id,
                    "relation": "contains",
                    "confidence": "EXTRACTED",
                    "confidence_score": 1.0,
                    "source_file": rel,
                    "source_location": f"L{line_num}",
                    "weight": 1.0,
                    "_src": file_id,
                    "_tgt": header_id,
                }
            )

    return nodes, links


def main() -> int:
    # Args: working_dir target output_dir [--include-docs] [--incremental]
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}

    if len(positional) != 3:
        print(
            "usage: graphify_build.py <working_dir> <target> <output_dir> [--include-docs] [--incremental]",
            file=sys.stderr,
        )
        return 2

    working_dir = Path(positional[0]).resolve()
    target_arg = positional[1]
    output_dir = Path(positional[2]).resolve()
    include_docs = "--include-docs" in flags
    incremental = "--incremental" in flags
    output_dir.mkdir(parents=True, exist_ok=True)

    code_files = resolve_targets(working_dir, target_arg)
    if not code_files:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"No supported code files found in {target_arg or working_dir}",
                }
            )
        )
        return 1

    os.environ["GRAPHIFY_OUT"] = str(output_dir)
    extraction = extract(code_files, cache_root=output_dir.parent)
    graph = build_from_json(extraction)
    communities = cluster(graph)
    cohesion = score_all(graph, communities)
    gods = god_nodes(graph)
    surprises = surprising_connections(graph, communities)
    labels = {cid: f"Community {cid}" for cid in communities}
    questions = suggest_questions(graph, communities, labels)
    built_at_commit = git_head(working_dir)

    graph_json = output_dir / "graph.json"
    report_md = output_dir / "GRAPH_REPORT.md"
    graph_html = output_dir / "graph.html"

    to_json(graph, communities, str(graph_json), force=True, built_at_commit=built_at_commit)

    # Merge document nodes into graph JSON (deterministic: headers/links from .md/.txt/.rst)
    doc_files: list[Path] = []
    if include_docs:
        doc_files = resolve_doc_targets(working_dir, target_arg)
        if doc_files:
            doc_nodes, doc_links = build_doc_nodes(doc_files, working_dir)
            graph_data = json.loads(graph_json.read_text(encoding="utf-8"))
            graph_data["nodes"].extend(doc_nodes)
            graph_data["links"].extend(doc_links)
            graph_json.write_text(json.dumps(graph_data, ensure_ascii=False))

    detection = {
        "files": {
            "code": [str(path.relative_to(working_dir)) for path in code_files],
            "document": [str(path.relative_to(working_dir)) for path in doc_files],
            "paper": [],
            "image": [],
            "video": [],
        },
        "total_files": len(code_files) + len(doc_files),
        "total_words": 0,
        "warning": None,
    }
    report = generate(
        graph,
        communities,
        cohesion,
        labels,
        gods,
        surprises,
        detection,
        {"input": 0, "output": 0},
        str(working_dir.name or working_dir),
        suggested_questions=questions,
        built_at_commit=built_at_commit,
    )
    report_md.write_text(report, encoding="utf-8")

    # Skip HTML in incremental mode (faster)
    html_written = False
    if not incremental:
        try:
            to_html(graph, communities, str(graph_html), community_labels=labels or None)
            html_written = True
        except ValueError:
            if graph_html.exists():
                graph_html.unlink()

    doc_count = len(doc_files) if include_docs else 0
    print(
        json.dumps(
            {
                "ok": True,
                "graph_json": str(graph_json),
                "report_md": str(report_md),
                "html_written": html_written,
                "indexed_files": len(code_files),
                "doc_files": doc_count,
                "nodes": graph.number_of_nodes() + (len(doc_nodes) if include_docs and doc_files else 0),
                "edges": graph.number_of_edges() + (len(doc_links) if include_docs and doc_files else 0),
                "communities": len(communities),
                "built_at_commit": built_at_commit,
                "target": target_arg or ".",
                "sample_files": [str(path.relative_to(working_dir)) for path in code_files[:25]],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
