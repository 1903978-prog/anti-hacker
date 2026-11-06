#!/usr/bin/env python3
"""Generate docs/aeos-compliance-register.md from reports/aeos-compliance.json (so the register
cannot disagree with the data the dashboard shows). Usage: register.py [--check]"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "reports/aeos-compliance.json")
DST = os.path.join(ROOT, "docs/aeos-compliance-register.md")
NOT_ENROLLED = [
    ("1903978-prog/diagnostic-platform", "fork; not confirmed as an Eendigo application"),
    ("1903978-prog/eat-well-goal", "personal project; not confirmed as an Eendigo application"),
    ("1903978-prog/claude-config", "configuration repository; proposed home for the central AEOS package (needs Livio's decision)"),
    ("1903978b-ui/anti-hacker", "other account; looks like a second copy of Secval; untouched"),
]


def build():
    d = json.load(open(SRC))
    L = [
        "# AEOS compliance register",
        "",
        f"Generated from `reports/aeos-compliance.json` (collected {d['collected_at']}, not live). "
        "Regenerate with `python3 scripts/aeos/register.py`; `test/aeos-register.test.ts` fails if this file and the data disagree.",
        "",
        "Score basis (out of 100): " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in d["score_basis"].items()) + ". "
        "It measures AEOS installation and proof, not application quality.",
        "",
        "| Application | Repository | AEOS | Validation | AEOS tests | Tasks (verified / not) | Open P0/P1 | Pull request | Fresh-session tests | Score |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for a in d["apps"]:
        pr = a.get("pr") or {}
        b = a.get("backlog") or {}
        fs = a.get("fresh_session") or {}
        L.append(
            f"| {a['application']} | {a.get('repository','')} | {a.get('aeos_version','')} | "
            f"{'passed' if a.get('validate',{}).get('ok') else 'FAILED'} | "
            f"{a.get('own_tests',{}).get('ran','?')} ran, {'passed' if a.get('own_tests',{}).get('ok') else 'FAILED'} | "
            f"{b.get('verified',0)} / {b.get('unverified',0)} | {b.get('open_p0_p1',0)} | "
            f"[#{pr.get('number','?')}]({pr.get('html_url','')}) draft, head {pr.get('head_sha','?')} | "
            f"{fs.get('passed','0')} of {fs.get('total','0')} | **{a['score']}** |"
        )
    L += ["", "## Not verified, per application (owner: Livio unless stated)", ""]
    for a in d["apps"]:
        items = a.get("unverified_items") or []
        L.append(f"- **{a['application']}**: " + ("; ".join(items) if items else "nothing recorded"))
    L += ["", "## Approvals still needed (none given)", ""]
    for a in d["apps"]:
        L.append(f"- **{a['application']}**: " + "; ".join(a.get("outstanding_approvals") or ["none recorded"]))
    L += ["", "## Not enrolled", ""]
    for r, why in NOT_ENROLLED:
        L.append(f"- `{r}`: {why}")
    L += ["", "Detect un-enrolled repositories: `python3 scripts/aeos/aeos.py audit <dir> <dir> ...`.", ""]
    return "\n".join(L)


if __name__ == "__main__":
    text = build()
    if "--check" in sys.argv:
        ok = os.path.isfile(DST) and open(DST).read() == text
        print("register is current" if ok else "register is OUT OF DATE")
        sys.exit(0 if ok else 1)
    open(DST, "w").write(text)
    print("wrote", DST)
