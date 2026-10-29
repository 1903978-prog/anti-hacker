#!/usr/bin/env python3
"""Stop hook for LIVIO'S TIME - RULE 1 (see top of CLAUDE.md).

Blocks the end of a turn when the last assistant message
  1. does not contain "Need from you:", or
  2. claims live/deployed/fixed but no tool call in this turn hit
     /api/version, /api/health (or /health) or a browser check.
Writing "not verified" in the message is the allowed alternative to a check.
"""
import json
import re
import sys

CLAIM = re.compile(r"\b(live|deployed|fixed)\b", re.I)
CHECK = re.compile(r"/api/version|/api/health|/health\b|playwright|chromium|screenshot|browser", re.I)
NOT_VERIFIED = re.compile(r"not verified", re.I)


def _blocks(entry):
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def evaluate(entries):
    """Return a plain-language reason to block, or None to pass."""
    turn_start = 0
    for i, e in enumerate(entries):
        if e.get("type") == "user" and any(b.get("type") == "text" for b in _blocks(e)):
            turn_start = i + 1
    turn = entries[turn_start:]

    text, tools = "", []
    for e in turn:
        if e.get("type") != "assistant":
            continue
        blocks = _blocks(e)
        for b in blocks:
            if b.get("type") == "tool_use":
                tools.append(json.dumps(b.get("name", "")) + json.dumps(b.get("input", {})))
        texts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
        if texts:
            text = "\n".join(texts)  # last assistant message with text

    if "Need from you:" not in text:
        return 'Rule 1: end the reply with "Need from you: Nothing" or exactly one ask.'
    if CLAIM.search(text) and not NOT_VERIFIED.search(text) and not any(CHECK.search(t) for t in tools):
        return ('Rule 2: you said live/deployed/fixed but did not check it this turn. '
                'Check /api/version, /api/health or a browser now, or write "not verified".')
    return None


def main():
    data = json.load(sys.stdin)
    if data.get("stop_hook_active"):  # already blocked once this turn; never loop
        return
    entries = []
    with open(data["transcript_path"], encoding="utf-8") as f:
        for line in f:
            try:
                entries.append(json.loads(line))
            except ValueError:
                pass
    reason = evaluate(entries)
    if reason:
        print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    main()
