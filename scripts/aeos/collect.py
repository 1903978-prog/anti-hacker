#!/usr/bin/env python3
"""Collect real AEOS compliance data from enrolled repositories (stdlib only, read-only).

Usage: python3 scripts/aeos/collect.py --manifest manifest.json --out reports/aeos-compliance.json
Manifest: {"apps": [{"dir": "/path/to/repo", "pr": {...optional, copied from GitHub...},
                     "fresh_session": {"passed": 3, "total": 3, "evidence": "docs/aeos-evidence/..."}}]}

It runs `aeos.py validate` and the repo's own `test_aeos.py` in each directory and reads .engineering/.
It makes no network call and changes nothing in the repositories. It is NOT real-time: the dashboard shows
the date this ran. Score (documented in `score_basis`) measures AEOS installation and verification, not the
quality of the application itself.
"""
import argparse, json, os, re, subprocess, sys
from datetime import datetime, timezone

SCORE_BASIS = {
    "installed": 20, "validate_ok": 25, "own_tests_pass": 20,
    "fresh_session_evidence": 15, "draft_pr_open_and_mergeable": 10, "no_open_p0_p1_or_blockers": 10,
}
CLOSED = ("RELEASED", "CANCELLED")


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=180, env={**os.environ, "AEOS_NESTED": "1"})


def read(d, rel):
    p = os.path.join(d, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""


def backlog(d):
    rows, by_status, by_verif, open_p01 = 0, {}, {}, 0
    for line in read(d, ".engineering/BACKLOG.md").splitlines():
        if re.match(r"\|\s*T-", line):
            c = [x.strip() for x in line.strip().strip("|").split("|")]
            if len(c) < 7:
                continue
            rows += 1
            by_status[c[3]] = by_status.get(c[3], 0) + 1
            by_verif[c[4]] = by_verif.get(c[4], 0) + 1
            if c[6] in ("P0", "P1") and c[3] not in CLOSED:
                open_p01 += 1
    return {"total": rows, "by_status": by_status, "by_verification": by_verif,
            "verified": by_verif.get("VERIFIED", 0), "unverified": rows - by_verif.get("VERIFIED", 0),
            "open_p0_p1": open_p01}


def collect_app(entry):
    d = entry["dir"]
    cfgp = os.path.join(d, ".engineering/aeos.config.json")
    out = {"installed": os.path.isfile(cfgp)}
    if not out["installed"]:
        out.update({"application": os.path.basename(d.rstrip("/")), "score": 0, "status": "NOT ENROLLED"})
        return out
    cfg = json.load(open(cfgp))
    py = sys.executable
    v = run([py, "scripts/aeos/aeos.py", "validate"], d)
    t = run([py, "scripts/aeos/test_aeos.py"], d)
    m = re.search(r"Ran (\d+) tests?", t.stderr + t.stdout)
    ran = int(m.group(1)) if m else 0
    tests_ok = t.returncode == 0 and ran > 0
    bl = backlog(d)
    blockers = [l for l in read(d, ".engineering/BLOCKERS.md").splitlines() if l.startswith("- [OPEN]")]
    ho = read(d, ".engineering/HANDOFF.md")
    cp = re.search(r"- Time: (.+)", ho)
    releases = [l for l in read(d, ".engineering/RELEASES.md").splitlines() if re.match(r"\|\s*[^|\-\s]", l) and "Candidate" not in l]
    git = lambda *a: run(["git", *a], d).stdout.strip()
    pr = entry.get("pr") or {}
    fs = entry.get("fresh_session") or {}
    fs_ok = bool(fs) and fs.get("total", 0) > 0 and fs.get("passed") == fs.get("total")
    pr_ok = bool(pr) and pr.get("state") == "open" and pr.get("draft") is True and pr.get("mergeable_state") == "clean"
    clean = bl["open_p0_p1"] == 0 and not blockers
    parts = {
        "installed": SCORE_BASIS["installed"],
        "validate_ok": SCORE_BASIS["validate_ok"] if v.returncode == 0 else 0,
        "own_tests_pass": SCORE_BASIS["own_tests_pass"] if tests_ok else 0,
        "fresh_session_evidence": SCORE_BASIS["fresh_session_evidence"] if fs_ok else 0,
        "draft_pr_open_and_mergeable": SCORE_BASIS["draft_pr_open_and_mergeable"] if pr_ok else 0,
        "no_open_p0_p1_or_blockers": SCORE_BASIS["no_open_p0_p1_or_blockers"] if clean else 0,
    }
    out.update({
        "application": cfg["application"], "repository": cfg["repository"], "aeos_version": cfg.get("aeos_version"),
        "branch": git("branch", "--show-current"), "head": git("rev-parse", "--short", "HEAD"),
        "validate": {"ok": v.returncode == 0, "output": (v.stdout.strip().splitlines() or [""])[0:6]},
        "own_tests": {"ran": ran, "ok": tests_ok},
        "backlog": bl, "open_blockers": len(blockers),
        "last_checkpoint": cp.group(1).strip() if cp else None,
        "releases_recorded": len(releases),
        "release_restrictions": len(cfg.get("release_restrictions", [])),
        "verified_config_facts": len(cfg.get("verified_facts", [])),
        "unverified_items": cfg.get("unverified", []),
        "pr": pr or None, "fresh_session": fs or None,
        "outstanding_approvals": ["merge of the install PR", "any production deploy", "confirmation of UNVERIFIED items"] if pr else ["any production deploy"],
        "release_readiness": "NOT READY: no release approval recorded" if not releases else "see RELEASES.md",
        "score_parts": parts, "score": sum(parts.values()),
    })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    man = json.load(open(a.manifest))
    apps = [collect_app(e) for e in man["apps"]]
    doc = {
        "schema": 1,
        "collected_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "collector": "scripts/aeos/collect.py",
        "realtime": False,
        "refresh": "Run scripts/aeos/collect.py again; nothing refreshes this file by itself.",
        "score_basis": SCORE_BASIS,
        "apps": apps,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print(f"collected {len(apps)} apps -> {a.out}; scores: " + ", ".join(f"{x['application']}={x['score']}" for x in apps))


if __name__ == "__main__":
    main()
