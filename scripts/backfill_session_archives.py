#!/usr/bin/env python3
"""
backfill_session_archives.py — one-time historical sweep of Claude Code
session transcripts → draft entries in session_archives/_drafts/.

Why this exists:
  The session_archives/ convention (see /CLAUDE.md and /session_archives/README.md)
  captures durable per-session learnings going forward. This script
  backfills the past — walks each user's local Claude Code JSONL session
  files and writes a draft archive entry per substantive session, so we
  don't lose the history we've already built up.

Each user runs this on their own Mac (Justin runs it for his JSONLs;
Nathan runs it for his). Local JSONLs are at:
  ~/.claude/projects/-Users-<name>-Documents-deal-command-center*/

Modes:
  dry-run (default) — list JSONLs that WOULD be processed, no API calls
  --run             — actually call Claude API and write drafts

Setup:
  export ANTHROPIC_API_KEY=sk-ant-…
    # Get from console.anthropic.com → API Keys
    # Or from Supabase vault (`supabase secrets list` shows the digest;
    # admin can retrieve the value via dashboard)

Output:
  session_archives/_drafts/<YYYY-MM-DD>-<short-slug>.md
  session_archives/_drafts/INDEX.md (summary of drafts written)

Reusability:
  Safe to re-run. Drafts get overwritten if the same JSONL is processed twice.
  Promote a draft to a real archive by:
    1. Reviewing the draft for accuracy + adding any missing context
    2. Moving it to session_archives/<same-filename>.md
    3. Adding a row to session_archives/index.md
    4. Deleting the _drafts/ copy

Cost:
  ~$0.50-$3 per user's full JSONL bundle, depending on session lengths.
  Sonnet-4.5 used for cost-effectiveness; can swap to Opus if results
  need higher fidelity.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

# ---- Constants ----
PROJECTS_DIR = Path.home() / ".claude" / "projects"
PROJECT_PREFIX = "-Users-"
PROJECT_SUFFIX_FILTER = "deal-command-center"
DRAFTS_DIR_NAME = Path("session_archives") / "_drafts"
MIN_JSONL_BYTES = 5_000  # skip trivially short sessions
MIN_CONVERSATION_CHARS = 2_000  # skip after-extraction shorts
MAX_TOKENS_INPUT = 180_000  # leave headroom in 200k context
APPROX_CHARS_PER_TOKEN = 4
MODEL = "claude-sonnet-4-5"

EXTRACTION_PROMPT = """You are looking at a Claude Code session transcript from a software project (DealCommand Center / RefundLocators / FundLocators). Your task is to write a session archive entry capturing the durable learnings.

Output a markdown document using EXACTLY this template:

---
# Session {date} — {short title (5-8 words)}

**Owner:** {Justin or Nathan, inferred from context if unclear}
**Source JSONL:** {path will be filled in by the script — leave as `<source>` and we'll replace it}
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
{1-3 sentences on the goal coming in. If it shifted mid-session, note that.}

## Decisions made (durable — these change behavior going forward)
- {bullets — only architectural / operational decisions worth preserving. Skip trivial choices.}

## Gotchas hit (non-obvious; future sessions need to know)
- {Symptom + root cause + how it was resolved. Skip if no real gotchas surfaced.}

## Files / systems touched
- **Repo files:** {list}
- **DB migrations:** {list, if any}
- **Edge functions deployed:** {list, if any}
- **External systems:** {Twilio / Magnetix / GitHub PRs / etc.}

## Open follow-ups
- [ ] {items mentioned at end as "to-do later" — likely already resolved by now, mark for verification}
---

Rules:
- Be CONCISE. Short bullets. No prose paragraphs.
- If the session is TRIVIAL (e.g. just a quick lookup, single small bug fix, minor doc edit, abandoned/unfinished topic with nothing learned) — instead of the template, output exactly the single line:
    TRIVIAL: <one-sentence why>
  And we'll skip writing a draft.
- Don't invent facts. If you're unsure, say "unclear from transcript".
- Use repo-relative paths (e.g. `src/app.jsx`, not `/Users/.../src/app.jsx`).
- Don't include any preamble before the template; start with the `---` line and end with the closing `---`.

Transcript follows.
"""


# ---- Data structures ----


@dataclass
class SessionFile:
    """One JSONL file representing a Claude Code session."""

    path: Path
    size_bytes: int
    started_at: datetime | None
    ended_at: datetime | None
    user_msg_count: int
    assistant_msg_count: int

    @property
    def date_slug(self) -> str:
        return (self.started_at or datetime.fromtimestamp(self.path.stat().st_mtime)).strftime("%Y-%m-%d")

    @property
    def short_id(self) -> str:
        return self.path.stem[:8]


# ---- JSONL parsing ----


def find_session_files() -> list[Path]:
    """Find all top-level Claude Code JSONLs for this project (skip subagents)."""
    out: list[Path] = []
    if not PROJECTS_DIR.exists():
        return out
    for project_dir in PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        if not project_dir.name.startswith(PROJECT_PREFIX):
            continue
        if PROJECT_SUFFIX_FILTER not in project_dir.name:
            continue
        # Top-level JSONLs only — skip subagents/, tool-results/, etc.
        for jsonl in project_dir.glob("*.jsonl"):
            if jsonl.is_file() and jsonl.stat().st_size >= MIN_JSONL_BYTES:
                out.append(jsonl)
    return sorted(out, key=lambda p: p.stat().st_mtime)


def parse_session(path: Path) -> tuple[SessionFile, str]:
    """Read JSONL, extract user/assistant text, return SessionFile + concatenated transcript."""
    user_count = 0
    assistant_count = 0
    started_at: datetime | None = None
    ended_at: datetime | None = None
    parts: list[str] = []

    with path.open("r", errors="replace") as f:
        for line_num, line in enumerate(f):
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            ts_str = obj.get("timestamp")
            ts = None
            if ts_str:
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except ValueError:
                    ts = None
            if ts is not None:
                if started_at is None or ts < started_at:
                    started_at = ts
                if ended_at is None or ts > ended_at:
                    ended_at = ts

            msg_type = obj.get("type")
            message = obj.get("message", {})
            content = message.get("content") if isinstance(message, dict) else None

            if msg_type == "user":
                # Skip pure tool_result entries; keep direct user prompts
                text = _extract_text(content)
                if text and not _is_tool_result_only(content):
                    parts.append(f"\n[USER]\n{text}")
                    user_count += 1
            elif msg_type == "assistant":
                text = _extract_text(content)
                if text:
                    parts.append(f"\n[ASSISTANT]\n{text}")
                    assistant_count += 1

    transcript = "\n".join(parts)
    sf = SessionFile(
        path=path,
        size_bytes=path.stat().st_size,
        started_at=started_at,
        ended_at=ended_at,
        user_msg_count=user_count,
        assistant_msg_count=assistant_count,
    )
    return sf, transcript


def _extract_text(content) -> str:
    """Get user-facing text from a message's content (str or list-of-blocks)."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                t = block.get("text", "")
                if t:
                    parts.append(t)
            elif block.get("type") == "tool_use":
                # Compact tool calls — keep enough to know what was done
                name = block.get("name", "?")
                inp = block.get("input", {})
                inp_compact = json.dumps(inp, separators=(",", ":"))[:300]
                parts.append(f"[tool_use:{name} {inp_compact}]")
        return "\n".join(parts).strip()
    return ""


def _is_tool_result_only(content) -> bool:
    """True if the user message is purely a tool_result (no human text)."""
    if not isinstance(content, list):
        return False
    return all(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


def truncate_transcript(transcript: str, max_chars: int) -> str:
    """If too long, keep the first chunk + the last chunk (skip middle)."""
    if len(transcript) <= max_chars:
        return transcript
    head = transcript[: max_chars // 3]
    tail = transcript[-(max_chars * 2 // 3) :]
    return f"{head}\n\n[...transcript truncated for length; middle elided...]\n\n{tail}"


# ---- Anthropic API call ----


def call_claude(transcript: str, date: str) -> str:
    """One API call — returns the model's response text."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY not set. Get a key at console.anthropic.com → API Keys, then `export ANTHROPIC_API_KEY=sk-ant-…`."
        )

    import urllib.request

    payload = json.dumps(
        {
            "model": MODEL,
            "max_tokens": 2048,
            "system": EXTRACTION_PROMPT.replace("{date}", date),
            "messages": [{"role": "user", "content": transcript}],
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read())
    blocks = body.get("content", [])
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()


# ---- Main flow ----


def slugify(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9\- ]", "", s).lower()
    s = re.sub(r"\s+", "-", s).strip("-")
    return s[:50] if s else "session"


def short_title_from_response(resp: str) -> str:
    """Pull the title from the first '# Session …' header."""
    m = re.search(r"^#\s*Session\s+\S+\s+—\s+(.+?)$", resp, re.MULTILINE)
    if m:
        return m.group(1).strip()
    return "session"


def write_draft(repo_root: Path, sf: SessionFile, response: str) -> Path:
    drafts_dir = repo_root / DRAFTS_DIR_NAME
    drafts_dir.mkdir(parents=True, exist_ok=True)
    title = short_title_from_response(response)
    slug = slugify(title)
    fname = f"{sf.date_slug}-{slug}-{sf.short_id}.md"
    out_path = drafts_dir / fname
    # Replace the source placeholder with the real path
    body = response.replace("`<source>`", f"`{sf.path}`")
    out_path.write_text(body)
    return out_path


def update_drafts_index(repo_root: Path, written: list[tuple[SessionFile, Path]]):
    drafts_dir = repo_root / DRAFTS_DIR_NAME
    index = drafts_dir / "INDEX.md"
    lines = [
        "# Session Archive Drafts (auto-generated backfill)",
        "",
        "These drafts were generated by `scripts/backfill_session_archives.py` from",
        "local JSONL session transcripts. They need human review before being",
        "promoted into `session_archives/` proper.",
        "",
        "## Promote a draft to a real archive",
        "1. Review the draft for accuracy. Add anything missing.",
        "2. Move it: `mv session_archives/_drafts/<file>.md session_archives/<file>.md`",
        "3. Add a one-line row to `session_archives/index.md` (newest first).",
        "4. Commit + push.",
        "",
        "## Drafts in this directory",
        "",
        "| Date | Source JSONL (short id) | Draft file |",
        "|---|---|---|",
    ]
    for sf, path in sorted(written, key=lambda t: (t[0].date_slug, t[0].short_id)):
        lines.append(f"| {sf.date_slug} | `{sf.short_id}` | [{path.name}](./{path.name}) |")
    lines.append("")
    index.write_text("\n".join(lines))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run", action="store_true", help="Actually call Claude API and write drafts (default is dry-run)")
    p.add_argument("--limit", type=int, help="Process at most N JSONLs (for testing)")
    p.add_argument("--repo-root", default=None, help="Override repo root detection")
    args = p.parse_args()

    if args.repo_root:
        repo_root = Path(args.repo_root)
    else:
        repo_root = Path(
            subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
        )

    sessions = find_session_files()
    if not sessions:
        print(f"No JSONL session files found under {PROJECTS_DIR}")
        return 0

    if args.limit:
        sessions = sessions[: args.limit]

    print(f"Found {len(sessions)} JSONL session files:")
    for path in sessions:
        size_kb = path.stat().st_size / 1024
        print(f"  • {path.relative_to(PROJECTS_DIR.parent)} ({size_kb:.1f} KB)")

    if not args.run:
        print()
        print("Dry-run mode (default). To actually process and write drafts:")
        print(f"  export ANTHROPIC_API_KEY=sk-ant-…")
        print(f"  python3 {Path(__file__).relative_to(repo_root)} --run")
        return 0

    if "ANTHROPIC_API_KEY" not in os.environ:
        print("ERROR: ANTHROPIC_API_KEY not set in environment", file=sys.stderr)
        return 1

    written: list[tuple[SessionFile, Path]] = []
    skipped: list[tuple[Path, str]] = []
    for i, path in enumerate(sessions, 1):
        print(f"\n[{i}/{len(sessions)}] {path.name}")
        sf, transcript = parse_session(path)
        if len(transcript) < MIN_CONVERSATION_CHARS:
            print(f"  → skip (transcript only {len(transcript)} chars after extraction)")
            skipped.append((path, "too short"))
            continue
        max_chars = MAX_TOKENS_INPUT * APPROX_CHARS_PER_TOKEN
        transcript = truncate_transcript(transcript, max_chars)
        print(f"  date={sf.date_slug} user_msgs={sf.user_msg_count} asst_msgs={sf.assistant_msg_count} chars={len(transcript)}")
        try:
            resp = call_claude(transcript, sf.date_slug)
        except Exception as e:
            print(f"  → API error: {e}")
            skipped.append((path, f"api error: {e}"))
            continue
        first = resp.lstrip().splitlines()[0] if resp.strip() else ""
        if first.startswith("TRIVIAL:"):
            print(f"  → trivial: {first[8:].strip()}")
            skipped.append((path, "trivial"))
            continue
        out = write_draft(repo_root, sf, resp)
        print(f"  → wrote {out.relative_to(repo_root)}")
        written.append((sf, out))

    if written:
        update_drafts_index(repo_root, written)
        print(f"\nWrote {len(written)} drafts to {DRAFTS_DIR_NAME}/")
        print(f"Index: {DRAFTS_DIR_NAME}/INDEX.md")
    else:
        print("\nNo drafts written.")
    if skipped:
        print(f"\nSkipped {len(skipped)} files:")
        for path, reason in skipped:
            print(f"  • {path.name}: {reason}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
