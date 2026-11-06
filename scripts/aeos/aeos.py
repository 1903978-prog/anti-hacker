#!/usr/bin/env python3
"""AEOS tool (stdlib only). Subcommands: validate, resume, checkpoint, attempt, install, audit.

Never touches the network, production, or application code.
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys
from datetime import datetime, timezone

VERSION = "1.0.0"
CANON = "EENDIGO_AEOS.md"
CONFIG = ".engineering/aeos.config.json"
LOCK = ".engineering/aeos.lock.json"
STATE_FILES = ["BACKLOG.md", "DECISIONS.md", "STATUS.md", "TESTS.md", "BLOCKERS.md",
               "HANDOFF.md", "RELEASES.md", "RELEASE_DOSSIER_TEMPLATE.md", "SECURITY_DB_BASELINE.md"]
REQUIRED_KEYS = ["application", "repository", "aeos_version", "production_environment",
                 "development_environment", "authorized_branches", "release_restrictions",
                 "data_sensitivity", "required_tests", "deployment_process", "rollback_process",
                 "execution_window_hours"]
STATUSES = ["BACKLOG", "IN PROGRESS", "IMPLEMENTED", "TESTING", "VERIFIED",
            "READY FOR RELEASE REVIEW", "RELEASED", "BLOCKED", "CANCELLED"]
VERIFS = ["VERIFIED", "PARTIAL", "UNVERIFIED", "FAILED", "BLOCKED"]
MARK_B, MARK_E = "<!-- AEOS:BEGIN -->", "<!-- AEOS:END -->"
HOOK_CMD = "python3 scripts/aeos/aeos.py resume --brief"
MAX_FAILS = 3
SECRET_RE = re.compile(r"(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|password|token)\s*[:=]\s*['\"]?[A-Za-z0-9/+_\-]{16,})", re.I)


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def git(root, *a):
    try:
        return subprocess.run(["git", "-C", root, *a], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        return ""


def load_cfg(root):
    p = os.path.join(root, CONFIG)
    if not os.path.isfile(p):
        return None
    return json.load(open(p))


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""


# ---------------------------------------------------------------- validate
def problems(root):
    out = []
    cfg = None
    canon = os.path.join(root, CANON)
    if not os.path.isfile(canon):
        out.append(f"missing {CANON}")
    else:
        if f"AEOS-VERSION: {VERSION}" not in open(canon, encoding="utf-8").read(400):
            out.append(f"{CANON} is not version {VERSION}")
        lp = os.path.join(root, LOCK)
        if not os.path.isfile(lp):
            out.append(f"missing {LOCK}")
        else:
            lock = json.load(open(lp))
            if lock.get("canonical_sha256") != sha256(canon):
                out.append(f"{CANON} differs from the locked canonical copy (drift)")
    try:
        cfg = load_cfg(root)
    except Exception as e:
        out.append(f"{CONFIG} is not valid JSON: {e}")
    if cfg is None and not any(CONFIG in o for o in out):
        out.append(f"missing {CONFIG}")
    if cfg:
        for k in REQUIRED_KEYS:
            if k not in cfg or cfg[k] in ("", None):
                out.append(f"config key missing or empty: {k}")
        if cfg.get("aeos_version") != VERSION:
            out.append(f"config aeos_version {cfg.get('aeos_version')} != {VERSION}")
    for f in STATE_FILES:
        if not os.path.isfile(os.path.join(root, ".engineering", f)):
            out.append(f"missing .engineering/{f}")
    cm = read(root, "CLAUDE.md")
    if MARK_B not in cm or CANON not in cm:
        out.append("CLAUDE.md has no AEOS block")
    if CANON not in read(root, "AGENTS.md"):
        out.append("AGENTS.md missing or does not reference AEOS")
    try:
        st = json.loads(read(root, ".claude/settings.json") or "{}")
        cmds = [h.get("command", "") for g in st.get("hooks", {}).get("SessionStart", []) for h in g.get("hooks", [])]
        if not any("aeos.py resume" in c for c in cmds):
            out.append("SessionStart hook for aeos.py resume not configured")
    except Exception as e:
        out.append(f".claude/settings.json invalid: {e}")
    for line in read(root, ".engineering/BACKLOG.md").splitlines():
        if re.match(r"\|\s*T-", line):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 6:
                out.append(f"BACKLOG row malformed: {line[:60]}")
                continue
            if cells[3] not in STATUSES:
                out.append(f"BACKLOG {cells[0]}: bad status '{cells[3]}'")
            if cells[4] not in VERIFS:
                out.append(f"BACKLOG {cells[0]}: bad verification '{cells[4]}'")
            if cells[3] == "RELEASED" and cells[5].upper() in ("", "-", "NO"):
                out.append(f"BACKLOG {cells[0]}: RELEASED without recorded release approval")
    eng = os.path.join(root, ".engineering")
    if os.path.isdir(eng):
        for f in os.listdir(eng):
            if f.endswith((".md", ".json")) and f != "aeos.lock.json":
                if SECRET_RE.search(read(root, f".engineering/{f}")):
                    out.append(f"possible secret in .engineering/{f}")
    return out


def cmd_validate(a):
    p = problems(a.root)
    if p:
        print("AEOS validate: FAIL")
        for x in p:
            print(" -", x)
        return 1
    print("AEOS validate: OK")
    return 0


# ---------------------------------------------------------------- resume
def cmd_resume(a):
    root = a.root
    cfg = None
    try:
        cfg = load_cfg(root)
    except Exception:
        pass
    if not cfg:
        print("AEOS: this repository is NOT enrolled (no .engineering/aeos.config.json). Run scripts/aeos/aeos.py install.")
        return 0
    br, sha = git(root, "branch", "--show-current"), git(root, "rev-parse", "--short", "HEAD")
    print(f"AEOS {cfg.get('aeos_version')} loaded. Application: {cfg['application']} | repo: {cfg['repository']} | branch: {br} | HEAD: {sha}")
    print(f"Scope: this repository only. Canonical rules: {CANON}. No task assigned = wait for the user's mandate; do not invent work.")
    for h in cfg.get("release_restrictions", []):
        print(h if h.startswith("HOLD") else f"HOLD: {h}")
    print("NEVER without separate written approval: merge to shared branches, deploy, change production data/credentials, message real people.")
    ho = read(root, ".engineering/HANDOFF.md")
    m = re.search(r"<!-- CHECKPOINT:BEGIN -->(.*?)<!-- CHECKPOINT:END -->", ho, re.S)
    if m and m.group(1).strip():
        cp = m.group(1).strip()
        print("Latest checkpoint:\n" + cp)
        cs = re.search(r"SHA:\s*(\w+)", cp)
        if cs and sha and not sha.startswith(cs.group(1)[:7]) and not cs.group(1).startswith(sha):
            cp_sha = cs.group(1)
            anc = subprocess.run(["git", "-C", root, "merge-base", "--is-ancestor", cp_sha, "HEAD"], capture_output=True).returncode
            if anc == 0:
                n = git(root, "rev-list", "--count", f"{cp_sha}..HEAD")
                print(f"NOTE: HEAD {sha} is {n} commit(s) after checkpoint {cp_sha} (normal). Review: git log {cp_sha}..HEAD")
            else:
                print(f"WARNING: checkpoint SHA {cp_sha} is NOT in this branch's history (rebased, other branch or other clone); do not trust the checkpoint's 'next task' until you check git log.")
    else:
        print("Latest checkpoint: none recorded.")
    bl = [l for l in read(root, ".engineering/BLOCKERS.md").splitlines() if l.startswith("- [OPEN]")]
    print(f"Open blockers: {len(bl)}")
    if not a.brief:
        for l in bl:
            print(" ", l)
    return 0


# ---------------------------------------------------------------- checkpoint
def cmd_checkpoint(a):
    root = a.root
    cfg = load_cfg(root)
    if not cfg:
        print("not enrolled", file=sys.stderr)
        return 2
    br, sha = git(root, "branch", "--show-current"), git(root, "rev-parse", "--short", "HEAD")
    body = (f"- Time: {now()}\n- Repo: {cfg['repository']}\n- Branch: {br}\n- SHA: {sha}\n"
            f"- Task done: {a.task}\n- Next task: {a.next}\n- Changes: {a.changes}\n"
            f"- Tests run: {a.tests}\n- Result: {a.result}\n- Blockers: {a.blockers}\n"
            f"- Approvals held: {a.approvals}\n- Release restrictions: {'; '.join(cfg.get('release_restrictions', []))}")
    hp = os.path.join(root, ".engineering/HANDOFF.md")
    ho = read(root, ".engineering/HANDOFF.md")
    blk = f"<!-- CHECKPOINT:BEGIN -->\n{body}\n<!-- CHECKPOINT:END -->"
    if "<!-- CHECKPOINT:BEGIN -->" in ho:
        ho = re.sub(r"<!-- CHECKPOINT:BEGIN -->.*?<!-- CHECKPOINT:END -->", lambda _: blk, ho, flags=re.S)
    else:
        ho += "\n" + blk + "\n"
    open(hp, "w", encoding="utf-8").write(ho)
    sp = os.path.join(root, ".engineering/STATUS.md")
    lines = read(root, ".engineering/STATUS.md").rstrip("\n").split("\n")
    lines.append(f"- {now()} | {sha} | {a.task} -> next: {a.next} | {a.result}")
    head = [l for l in lines if not l.startswith("- 20")]
    log = [l for l in lines if l.startswith("- 20")][-50:]
    open(sp, "w", encoding="utf-8").write("\n".join(head + log) + "\n")
    print(f"checkpoint saved at {sha}")
    return 0


# ---------------------------------------------------------------- attempt
def cmd_attempt(a):
    p = os.path.join(a.root, ".engineering/attempts.json")
    d = json.load(open(p)) if os.path.isfile(p) else {}
    e = d.setdefault(a.key, {"fails": 0})
    if a.outcome == "fail":
        e["fails"] += 1
    else:
        e["fails"] = 0
    json.dump(d, open(p, "w"), indent=1, sort_keys=True)
    if e["fails"] >= MAX_FAILS:
        print(f"STOP: '{a.key}' failed {e['fails']} times. Record the cause in .engineering/BLOCKERS.md and move to other work.")
        return 3
    print(f"'{a.key}': {e['fails']}/{MAX_FAILS} failures")
    return 0


# ---------------------------------------------------------------- install
def merge_settings(root):
    p = os.path.join(root, ".claude/settings.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    st = json.loads(read(root, ".claude/settings.json") or "{}")
    ss = st.setdefault("hooks", {}).setdefault("SessionStart", [])
    if not any("aeos.py resume" in h.get("command", "") for g in ss for h in g.get("hooks", [])):
        ss.append({"hooks": [{"type": "command", "command": HOOK_CMD}]})
    json.dump(st, open(p, "w"), indent=2)
    open(p, "a").write("\n")


def claude_block(cfg):
    return (f"{MARK_B}\n## EENDIGO AEOS (v{VERSION}) — {cfg['application']}\n"
            f"Read and follow `{CANON}` (canonical, do not edit here) and `{CONFIG}` at the start of every session in this repo; "
            "state lives in `.engineering/`. Everything above this block stays in force; where it is stricter, it wins. "
            "AEOS adds: one business-decision round, checkpoints, no production action without separate written approval.\n"
            f"@{CANON}\n{MARK_E}\n")


def cmd_install(a):
    pkg = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    root = a.target
    prof = json.load(open(a.profile))
    cfg = {"aeos_version": VERSION, "execution_window_hours": 5, **prof}
    os.makedirs(os.path.join(root, ".engineering"), exist_ok=True)
    os.makedirs(os.path.join(root, "scripts/aeos"), exist_ok=True)
    shutil.copy(os.path.join(pkg, CANON), os.path.join(root, CANON))
    for f in ("aeos.py", "test_aeos.py", "run_fresh.sh", "collect.py"):
        s = os.path.join(pkg, "scripts/aeos", f)
        if os.path.isfile(s) and os.path.abspath(s) != os.path.abspath(os.path.join(root, "scripts/aeos", f)):
            shutil.copy(s, os.path.join(root, "scripts/aeos", f))
    tdir = os.path.join(pkg, "scripts/aeos/templates")
    tdst = os.path.join(root, "scripts/aeos/templates")
    if os.path.abspath(tdir) != os.path.abspath(tdst):
        shutil.copytree(tdir, tdst, dirs_exist_ok=True)
    for f in STATE_FILES:
        dst = os.path.join(root, ".engineering", f)
        if not os.path.exists(dst):  # never overwrite existing state
            shutil.copy(os.path.join(tdir, f), dst)
            if f == "BACKLOG.md":
                t = open(dst).read().replace("{{APP}}", cfg["application"])
                open(dst, "w").write(t)
    json.dump(cfg, open(os.path.join(root, CONFIG), "w"), indent=2)
    open(os.path.join(root, CONFIG), "a").write("\n")
    json.dump({"aeos_version": VERSION, "canonical_sha256": sha256(os.path.join(root, CANON))},
              open(os.path.join(root, LOCK), "w"), indent=2)
    open(os.path.join(root, LOCK), "a").write("\n")
    wf = os.path.join(tdir, "aeos-validate.yml")
    if os.path.isfile(wf):
        os.makedirs(os.path.join(root, ".github/workflows"), exist_ok=True)
        shutil.copy(wf, os.path.join(root, ".github/workflows/aeos-validate.yml"))
    cm = read(root, "CLAUDE.md")
    blk = claude_block(cfg)
    if MARK_B in cm:
        cm = re.sub(re.escape(MARK_B) + ".*?" + re.escape(MARK_E) + "\n?", lambda _: blk, cm, flags=re.S)
    else:
        cm = cm.rstrip("\n") + "\n\n" + blk if cm else blk
    open(os.path.join(root, "CLAUDE.md"), "w", encoding="utf-8").write(cm)
    ag = read(root, "AGENTS.md")
    if CANON not in ag:
        ag += ("# Agents\n\n" if not ag else "\n") + f"Follow `{CANON}` and `{CONFIG}`; the repository's `CLAUDE.md` holds are binding for every agent. State is in `.engineering/`.\n"
        open(os.path.join(root, "AGENTS.md"), "w").write(ag)
    merge_settings(root)
    print(f"installed AEOS {VERSION} into {root}")
    return cmd_validate(argparse.Namespace(root=root))


# ---------------------------------------------------------------- audit
def cmd_audit(a):
    bad = 0
    for d in a.dirs:
        try:
            cfg = load_cfg(d)
        except Exception:
            cfg = None
        if not cfg:
            print(f"NOT ENROLLED  {d}")
            bad += 1
            continue
        p = problems(d)
        print(f"{'OK' if not p else 'GAPS'}  {d}  [{cfg['application']}  v{cfg.get('aeos_version')}]" + ("" if not p else "  " + "; ".join(p)))
        bad += bool(p)
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(prog="aeos")
    ap.add_argument("--root", default=".")
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("validate")
    r = sp.add_parser("resume"); r.add_argument("--brief", action="store_true")
    c = sp.add_parser("checkpoint")
    for k in ("task", "next"):
        c.add_argument("--" + k, required=True)
    for k in ("changes", "tests", "result", "blockers", "approvals"):
        c.add_argument("--" + k, default="none")
    t = sp.add_parser("attempt"); t.add_argument("--key", required=True); t.add_argument("--outcome", choices=["fail", "ok"], required=True)
    i = sp.add_parser("install"); i.add_argument("--target", required=True); i.add_argument("--profile", required=True)
    u = sp.add_parser("audit"); u.add_argument("dirs", nargs="+")
    a = ap.parse_args()
    sys.exit({"validate": cmd_validate, "resume": cmd_resume, "checkpoint": cmd_checkpoint,
              "attempt": cmd_attempt, "install": cmd_install, "audit": cmd_audit}[a.cmd](a))


if __name__ == "__main__":
    main()
