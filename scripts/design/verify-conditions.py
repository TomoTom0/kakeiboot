#!/usr/bin/env python3
"""Verify tests/design/conditions.toml against [covers:<id>] tags in test files.

Checks (see ~/.claude/skills/test-structure/SKILL.md section 4):
  (a) every covers tag points to an existing condition id (no dangling tags)
  (b) every condition is covered by at least one tag
  (c) conditions.toml schema sanity (required fields, expect_*, id format, given)
  (d) source_lines metadata is synced from the actual tag locations (the only write)
  (e) [[excluded]] entries have non-empty item / source / reason

Usage:
  uv run --no-project python scripts/design/verify-conditions.py [conditions.toml] [--strict-source]

Exit code is non-zero on any failure. Written to be run with uv (no project deps).
"""

from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
# Test sources scanned for [covers:<id>] tags. Rust integration tests, frontend tests,
# and the deploy ops unittest (scripts/deploy/, TASK-118).
TEST_GLOBS = ["backend/tests/*.rs", "backend/src/**/*.rs", "frontend/tests/**/*.ts", "scripts/deploy/*.py"]
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$")
TAG_RE = re.compile(r"\[covers:([A-Za-z0-9._-]+)\]")
EXPECT_KEYS = ("expect_return", "expect_return_shape", "expect_throw", "expect_no_throw")


def scan_test_files() -> list[Path]:
    files: list[Path] = []
    for pattern in TEST_GLOBS:
        files.extend(sorted(REPO_ROOT.glob(pattern)))
    return files


def collect_tags(files: list[Path]) -> dict[str, list[str]]:
    """Map condition id -> list of "path:line" (path relative to repo root)."""
    tags: dict[str, list[str]] = {}
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(text.splitlines(), start=1):
            for cond_id in TAG_RE.findall(line):
                tags.setdefault(cond_id, []).append(f"{path.relative_to(REPO_ROOT)}:{lineno}")
    return tags


def check_schema(data: dict, toml_path: Path, strict_source: bool) -> list[str]:
    errors: list[str] = []
    meta = data.get("meta")
    if not isinstance(meta, dict):
        return [f"{toml_path}: missing [meta]"]
    for key in ("feature", "source_file"):
        if not str(meta.get(key, "")).strip():
            errors.append(f"{toml_path}: [meta] missing '{key}'")
    # Single-file layout: this repo keeps every condition in conditions.toml
    # (per TASK instruction), so meta.feature names the area instead of the
    # file stem. The stem check applies only when files are split per feature.
    if toml_path.stem != "conditions" and str(meta.get("feature", "")).strip() != toml_path.stem:
        errors.append(f"{toml_path}: meta.feature must equal the file stem '{toml_path.stem}'")

    conditions = data.get("condition", [])
    if not conditions:
        errors.append(f"{toml_path}: no [[condition]] entries")
    seen_ids: set[str] = set()
    for i, cond in enumerate(conditions):
        label = f"{toml_path}: condition[{i}]"
        cond_id = str(cond.get("id", ""))
        if not cond_id:
            errors.append(f"{label}: missing 'id'")
            continue
        label = f"{toml_path}: condition '{cond_id}'"
        if not ID_RE.match(cond_id):
            errors.append(f"{label}: id is not <area>.<kebab-topic> (lowercase ascii)")
        if cond_id in seen_ids:
            errors.append(f"{label}: duplicate id")
        seen_ids.add(cond_id)
        for key in ("target_function", "description", "given"):
            if not str(cond.get(key, "")).strip():
                errors.append(f"{label}: missing '{key}'")
        if strict_source and not str(cond.get("source", "")).strip():
            errors.append(f"{label}: missing 'source' (--strict-source)")
        if not any(str(cond.get(k, "")).strip() for k in EXPECT_KEYS):
            errors.append(f"{label}: needs one of {', '.join(EXPECT_KEYS)}")

    for i, exc in enumerate(data.get("excluded", [])):
        label = f"{toml_path}: excluded[{i}]"
        for key in ("item", "source", "reason"):
            if not str(exc.get(key, "")).strip():
                errors.append(f"{label}: missing '{key}'")
    return errors


def sync_source_lines(toml_path: Path, tags: dict[str, list[str]]) -> bool:
    """Rewrite source_lines values from the scanned tags. Returns True if changed."""
    lines = toml_path.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    changed = False
    current_id: str | None = None
    in_condition = False
    source_lines_done = False

    def make_line(cond_id: str) -> str:
        locs = ", ".join(tags.get(cond_id, []))
        return f'source_lines = "{locs}"'

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[[condition]]"):
            in_condition = True
            source_lines_done = False
            current_id = None
            out.append(line)
            continue
        if stripped.startswith("[[") or (stripped.startswith("[") and not stripped.startswith("[[")):
            in_condition = False
            out.append(line)
            continue
        if in_condition and stripped.startswith('id = "'):
            m = re.match(r'id = "(.*)"', stripped)
            current_id = m.group(1) if m else None
            out.append(line)
            continue
        if in_condition and current_id and stripped.startswith("source_lines"):
            new = make_line(current_id)
            if line != new:
                changed = True
            out.append(new)
            source_lines_done = True
            continue
        if in_condition and current_id and not source_lines_done and stripped.startswith("description"):
            # insert source_lines right before description when absent
            out.append(make_line(current_id))
            changed = True
            source_lines_done = True
            out.append(line)
            continue
        out.append(line)

    if changed:
        toml_path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return changed


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    strict_source = "--strict-source" in sys.argv[1:]
    toml_path = (
        (REPO_ROOT / args[0]).resolve() if args else REPO_ROOT / "tests/design/conditions.toml"
    )
    if not toml_path.exists():
        print(f"error: {toml_path} not found")
        return 1

    data = tomllib.loads(toml_path.read_text(encoding="utf-8"))
    files = scan_test_files()
    tags = collect_tags(files)

    errors = check_schema(data, toml_path, strict_source)

    condition_ids = {str(c.get("id", "")) for c in data.get("condition", [])}
    dangling = sorted(set(tags) - condition_ids)
    for cond_id in dangling:
        errors.append(f"dangling tag: [{cond_id}] at {', '.join(tags[cond_id])}")
    for cond in data.get("condition", []):
        cond_id = str(cond.get("id", ""))
        if cond_id and cond_id not in tags:
            errors.append(f"uncovered condition: {cond_id}")

    if sync_source_lines(toml_path, tags):
        print(f"synced source_lines in {toml_path}")

    if errors:
        for e in errors:
            print(f"FAIL {e}")
        print(f"{len(errors)} error(s)")
        return 1
    count = len(data.get("condition", []))
    excluded = len(data.get("excluded", []))
    print(f"OK {toml_path.relative_to(REPO_ROOT)}: {count} conditions, {excluded} excluded, "
          f"{len(files)} test files scanned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
