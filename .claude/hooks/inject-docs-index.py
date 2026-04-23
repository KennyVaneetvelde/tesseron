#!/usr/bin/env python3
"""
UserPromptSubmit hook: inject a generated index of the Tesseron docs.

Walks `docs/src/content/docs/**/*.{md,mdx}`, pulls `title` / `description`
from YAML frontmatter, and emits a grouped table-of-contents as
`additionalContext`. No static INDEX file to drift: the index is
re-derived on every prompt.

If the docs tree is missing or unreadable, exit 0 silently.
"""

import json
import os
import re
import sys
from pathlib import Path

DOCS_SUBPATH = Path("docs") / "src" / "content" / "docs"
# Order matters - controls the section order in the injected index.
SECTION_ORDER = ["overview", "protocol", "sdk", "examples"]
SECTION_LABELS = {
    "overview": "Overview",
    "protocol": "Protocol (wire format, transport, lifecycle, security)",
    "sdk": "SDK (TypeScript packages, Python plans, porting guide)",
    "examples": "Examples (runnable apps demonstrating each adapter)",
}


def parse_frontmatter(text: str) -> dict:
    """Extract top-level string fields from a YAML frontmatter block.

    Only handles the subset we need: `title:` and `description:`, single-line
    or block-scalar (`|`, `>`). Avoids a PyYAML dependency.
    """
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    block = text[3:end].strip("\n")
    result: dict = {}
    key: str | None = None
    folded_indent: int | None = None
    folded_lines: list[str] = []

    def flush_folded():
        nonlocal key, folded_indent, folded_lines
        if key is not None and folded_lines:
            result[key] = " ".join(line.strip() for line in folded_lines).strip()
        key = None
        folded_indent = None
        folded_lines = []

    for raw in block.splitlines():
        if folded_indent is not None:
            stripped = raw.lstrip(" ")
            indent = len(raw) - len(stripped)
            if raw.strip() and indent >= folded_indent:
                folded_lines.append(stripped)
                continue
            flush_folded()
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", raw)
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        if v in ("|", ">"):
            key = k
            folded_indent = 2  # assume two-space indent for folded content
            folded_lines = []
            continue
        if v.startswith(('"', "'")) and v.endswith(v[0]) and len(v) >= 2:
            v = v[1:-1]
        result[k] = v
    flush_folded()
    return result


def extract(doc_path: Path, project_root: Path) -> tuple[str, str, str]:
    """Return (title, description, repo-relative-path) for a doc file."""
    try:
        text = doc_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ("", "", str(doc_path.relative_to(project_root)))
    fm = parse_frontmatter(text)
    title = fm.get("title", "").strip() or doc_path.stem
    desc = fm.get("description", "").strip()
    return (title, desc, str(doc_path.relative_to(project_root)).replace("\\", "/"))


def build_index(project_root: Path) -> str:
    docs_root = project_root / DOCS_SUBPATH
    if not docs_root.is_dir():
        return ""

    buckets: dict[str, list[tuple[str, str, str]]] = {name: [] for name in SECTION_ORDER}
    root_entries: list[tuple[str, str, str]] = []

    for path in sorted(docs_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in (".md", ".mdx"):
            continue
        rel_to_docs = path.relative_to(docs_root)
        parts = rel_to_docs.parts
        entry = extract(path, project_root)
        if len(parts) == 1:
            root_entries.append(entry)
            continue
        section = parts[0]
        buckets.setdefault(section, []).append(entry)

    lines: list[str] = []
    lines.append("# Tesseron docs index")
    lines.append("")
    lines.append(
        "Each row points at a published docs page. Treat these as the canonical "
        "description of the protocol and SDK surface. Read the file itself - not "
        "just this index - before answering questions about Tesseron behavior."
    )
    lines.append("")

    if root_entries:
        lines.append("## Landing")
        lines.append("")
        for title, desc, rel in root_entries:
            lines.append(f"- **{title}** ({rel}) - {desc}" if desc else f"- **{title}** ({rel})")
        lines.append("")

    for section in SECTION_ORDER:
        entries = buckets.get(section) or []
        if not entries:
            continue
        lines.append(f"## {SECTION_LABELS.get(section, section.title())}")
        lines.append("")
        for title, desc, rel in entries:
            lines.append(f"- **{title}** ({rel}) - {desc}" if desc else f"- **{title}** ({rel})")
        lines.append("")

    extras = {k: v for k, v in buckets.items() if k not in SECTION_ORDER and v}
    for section, entries in sorted(extras.items()):
        lines.append(f"## {section.title()}")
        lines.append("")
        for title, desc, rel in entries:
            lines.append(f"- **{title}** ({rel}) - {desc}" if desc else f"- **{title}** ({rel})")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or input_data.get("cwd") or ""
    if not project_dir:
        sys.exit(0)
    project_root = Path(project_dir)

    try:
        index = build_index(project_root)
    except Exception:
        sys.exit(0)
    if not index:
        sys.exit(0)

    additional = (
        "<MANDATORY_INSTRUCTION>\n"
        "BEFORE answering any question about Tesseron protocol behavior, SDK\n"
        "surface, or package APIs, you MUST:\n"
        "1. Acknowledge which docs page(s) cover the topic.\n"
        "2. Read the relevant file(s) under docs/src/content/docs/ (paths\n"
        "   listed in the index below) before exploring the source or\n"
        "   answering from memory.\n"
        "\n"
        "AFTER completing any change to packages/ source that alters\n"
        "protocol behavior, public types, exported functions, hook APIs,\n"
        "or CLI flags, you MUST:\n"
        "1. List the modified files.\n"
        "2. Identify which docs page(s) describe the changed surface.\n"
        "3. End with either:\n"
        "   - 'Running update-docs skill to sync documentation.' then invoke it, OR\n"
        "   - 'No docs updates needed because [reason].'\n"
        "\n"
        "If the change is test-only, tooling-only, or internal refactor with\n"
        "no public surface shift, state that and skip the update.\n"
        "</MANDATORY_INSTRUCTION>\n"
        "\n"
        "=== TESSERON DOCS INDEX ===\n"
        "\n"
        f"{index}"
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": additional,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
