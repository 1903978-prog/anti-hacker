"""Run: python3 .claude/hooks/test_livio_time_check.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from livio_time_check import evaluate

U = {"type": "user", "message": {"content": "do it"}}


def A(text=None, tool=None):
    c = []
    if tool:
        c.append({"type": "tool_use", "name": "Bash", "input": {"command": tool}})
    if text:
        c.append({"type": "text", "text": text})
    return {"type": "assistant", "message": {"content": c}}


MUST_BLOCK = {
    "no Need-from-you line": [U, A("All good.")],
    "claims live, no check": [U, A("It is live now.\nNeed from you: Nothing")],
    "claims deployed, check was in an earlier turn": [
        A(tool="curl https://x/api/version"), U, A("Deployed.\nNeed from you: Nothing")],
}
MUST_PASS = {
    "plain answer with ask line": [U, A("Done is not claimed here.\nNeed from you: Nothing")],
    "live claim backed by /api/version": [
        U, A(tool="curl https://x/api/version"), A("It is live.\nNeed from you: Nothing")],
    "live claim backed by /health": [
        U, A(tool="curl https://x/health"), A("Fixed and live.\nNeed from you: One ask")],
    "live claim with 'not verified'": [U, A("Probably live, not verified.\nNeed from you: Nothing")],
}

bad = 0
for name, t in MUST_BLOCK.items():
    ok = evaluate(t) is not None
    bad += not ok
    print(("ok   " if ok else "FAIL ") + "must-block: " + name)
for name, t in MUST_PASS.items():
    ok = evaluate(t) is None
    bad += not ok
    print(("ok   " if ok else "FAIL ") + "must-pass:  " + name)
sys.exit(1 if bad else 0)
