#!/usr/bin/env python3
"""Executable AEOS acceptance tests. Uses temporary directories and two synthetic application profiles.
Never touches the real repository's state files. Run: python3 scripts/aeos/test_aeos.py
Criteria that need a live Claude Code session are NOT covered here (see .engineering/TESTS.md, manual)."""
import json, os, subprocess, sys, tempfile, unittest, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(os.path.dirname(HERE))
AEOS = os.path.join(HERE, "aeos.py")

PROFILES = {
    "alpha": {"application": "Alpha App", "repository": "eendigo/alpha", "production_environment": "Fly (alpha-prod)",
              "development_environment": "local", "authorized_branches": ["claude/*"],
              "release_restrictions": ["HOLD: exact words 'ship it' required before any push"],
              "data_sensitivity": "client financials", "required_tests": ["npm test"],
              "deployment_process": "manual Fly deploy, user approval", "rollback_process": "fly releases rollback"},
    "beta": {"application": "Beta App", "repository": "eendigo/beta", "production_environment": "Render (beta)",
             "development_environment": "local", "authorized_branches": ["feat/*"],
             "release_restrictions": ["HOLD: no deploy before 2026-12-01"],
             "data_sensitivity": "public market data", "required_tests": ["pytest"],
             "deployment_process": "Render auto from main after approval", "rollback_process": "Render rollback"},
}


def run(*args, cwd=None, root=None):
    cmd = [sys.executable, AEOS] + (["--root", root] if root else []) + list(args)
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)


class Base(unittest.TestCase):
    def make_repo(self, name):
        d = tempfile.mkdtemp(prefix="aeos-" + name + "-")
        self.addCleanup(shutil.rmtree, d, True)
        subprocess.run(["git", "init", "-q", "-b", "claude/test", d], check=True)
        subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], check=True)
        open(os.path.join(d, "CLAUDE.md"), "w").write("# Existing rules\nNEVER delete anything. KEEP-ME\n")
        pf = os.path.join(d, "profile.json")
        json.dump(PROFILES[name], open(pf, "w"))
        r = run("install", "--target", d, "--profile", pf)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        os.remove(pf)
        return d


class TestAeos(Base):
    # 1,2,3: detect app, load AEOS, keep existing instructions
    def test_two_apps_identified_separately(self):
        for name in PROFILES:
            d = self.make_repo(name)
            out = run("resume", "--brief", root=d).stdout
            self.assertIn(PROFILES[name]["application"], out)
            other = [p["application"] for n, p in PROFILES.items() if n != name][0]
            self.assertNotIn(other, out)
            self.assertIn("Scope: this repository only", out)

    def test_existing_claude_md_preserved_and_idempotent(self):
        d = self.make_repo("alpha")
        before = open(os.path.join(d, "CLAUDE.md")).read()
        self.assertIn("KEEP-ME", before)
        self.assertEqual(before.count("AEOS:BEGIN"), 1)
        pf = os.path.join(d, "p.json"); json.dump(PROFILES["alpha"], open(pf, "w"))
        run("install", "--target", d, "--profile", pf)
        after = open(os.path.join(d, "CLAUDE.md")).read()
        self.assertEqual(after.count("AEOS:BEGIN"), 1)
        self.assertIn("KEEP-ME", after)

    def test_state_not_overwritten_on_reinstall(self):
        d = self.make_repo("beta")
        p = os.path.join(d, ".engineering/DECISIONS.md")
        open(p, "a").write("| D1 | x | keep this | user | all |\n")
        pf = os.path.join(d, "p.json"); json.dump(PROFILES["beta"], open(pf, "w"))
        run("install", "--target", d, "--profile", pf)
        self.assertIn("keep this", open(p).read())

    def test_session_start_hook_present_and_existing_hooks_kept(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        subprocess.run(["git", "init", "-q", d], check=True)
        os.makedirs(os.path.join(d, ".claude"))
        json.dump({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo keep"}]}]}}, open(os.path.join(d, ".claude/settings.json"), "w"))
        pf = os.path.join(d, "p.json"); json.dump(PROFILES["alpha"], open(pf, "w"))
        self.assertEqual(run("install", "--target", d, "--profile", pf).returncode, 0)
        st = json.load(open(os.path.join(d, ".claude/settings.json")))
        self.assertIn("Stop", st["hooks"]); self.assertIn("SessionStart", st["hooks"])

    # 15 / 12: holds are surfaced, deploy is never authorised by the tool
    def test_release_hold_shown_at_start(self):
        d = self.make_repo("alpha")
        out = run("resume", "--brief", root=d).stdout
        self.assertIn("ship it", out)
        self.assertIn("NEVER without separate written approval", out)

    # 8, 9: checkpoint and recovery
    def test_checkpoint_then_resume_recovers_task(self):
        d = self.make_repo("alpha")
        r = run("checkpoint", "--task", "T-ALPHA-1 fix rounding", "--next", "T-ALPHA-2 add test", "--tests", "unit 12/12", "--result", "VERIFIED", root=d)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = run("resume", root=d).stdout
        self.assertIn("T-ALPHA-2 add test", out)
        self.assertIn("unit 12/12", out)
        self.assertIn("T-ALPHA-1", open(os.path.join(d, ".engineering/STATUS.md")).read())

    def test_resume_flags_sha_change(self):
        d = self.make_repo("alpha")
        run("checkpoint", "--task", "a", "--next", "b", root=d)
        subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "more"], check=True)
        self.assertIn("commit(s) after checkpoint", run("resume", root=d).stdout)

    # 10: no endless repeats
    def test_retry_limit_stops_after_three(self):
        d = self.make_repo("beta")
        codes = [run("attempt", "--key", "full-audit", "--outcome", "fail", root=d).returncode for _ in range(3)]
        self.assertEqual(codes, [0, 0, 3])
        self.assertEqual(run("attempt", "--key", "full-audit", "--outcome", "ok", root=d).returncode, 0)

    # checkpoint drift is described precisely (ancestor = normal, foreign = warning)
    def test_resume_says_commits_after_checkpoint_is_normal(self):
        d = self.make_repo("alpha")
        run("checkpoint", "--task", "a", "--next", "b", root=d)
        subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "more"], check=True)
        out = run("resume", "--brief", root=d).stdout
        self.assertIn("commit(s) after checkpoint", out)
        self.assertIn("(normal)", out)
        self.assertNotIn("WARNING", out)

    def test_resume_warns_when_checkpoint_not_in_history(self):
        d = self.make_repo("alpha")
        run("checkpoint", "--task", "a", "--next", "b", root=d)
        h = os.path.join(d, ".engineering/HANDOFF.md")
        txt = open(h).read()
        import re as _re
        open(h, "w").write(_re.sub(r"SHA: \w+", "SHA: deadbee", txt))
        out = run("resume", "--brief", root=d).stdout
        self.assertIn("WARNING: checkpoint SHA deadbee is NOT in this branch", out)

    # validation / drift / honesty
    def test_validate_passes_then_detects_drift(self):
        d = self.make_repo("alpha")
        self.assertEqual(run("validate", root=d).returncode, 0)
        open(os.path.join(d, "EENDIGO_AEOS.md"), "a").write("\nweakened rule\n")
        r = run("validate", root=d)
        self.assertEqual(r.returncode, 1); self.assertIn("drift", r.stdout)

    def test_validate_rejects_bad_backlog_and_unapproved_release(self):
        d = self.make_repo("alpha")
        p = os.path.join(d, ".engineering/BACKLOG.md")
        open(p, "a").write("| T-ALPHA-1 | core | x | DONE | PASSED | no | P1 | - | - |\n")
        out = run("validate", root=d).stdout
        self.assertIn("bad status", out); self.assertIn("bad verification", out)
        open(p, "a").write("| T-ALPHA-2 | core | y | RELEASED | VERIFIED | no | P1 | - | - |\n")
        self.assertIn("RELEASED without recorded release approval", run("validate", root=d).stdout)

    def test_validate_flags_secret(self):
        d = self.make_repo("alpha")
        open(os.path.join(d, ".engineering/NOTES.md"), "w").write("api_key = " + "x" * 24 + "\n")
        self.assertIn("possible secret", run("validate", root=d).stdout)

    def test_audit_detects_unenrolled(self):
        d = self.make_repo("alpha")
        e = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, e, True)
        r = run("audit", d, e)
        self.assertEqual(r.returncode, 1)
        self.assertIn("NOT ENROLLED", r.stdout); self.assertIn("OK", r.stdout)

    def test_unenrolled_resume_says_so(self):
        e = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, e, True)
        self.assertIn("NOT enrolled", run("resume", "--brief", root=e).stdout)


@unittest.skipIf(os.environ.get("AEOS_NESTED") == "1", "collector tests must not recurse into the test run they trigger")
class TestCollector(Base):
    """The compliance collector reports real results of validate and the repo's own tests."""
    def collect(self, entries):
        m = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, m, True)
        mp, op = os.path.join(m, "m.json"), os.path.join(m, "out.json")
        json.dump({"apps": entries}, open(mp, "w"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "collect.py"), "--manifest", mp, "--out", op], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return json.load(open(op))

    def test_full_score_needs_every_proof_and_is_per_app(self):
        a, b = self.make_repo("alpha"), self.make_repo("beta")
        for d in (a, b):  # the collector runs each repo's own test file
            shutil.copy(os.path.join(HERE, "test_aeos.py"), os.path.join(d, "scripts/aeos/test_aeos.py"))
        pr = {"state": "open", "draft": True, "mergeable_state": "clean", "html_url": "https://example.test/pr/1"}
        doc = self.collect([
            {"dir": a, "pr": pr, "fresh_session": {"passed": 3, "total": 3}},
            {"dir": b},
        ])
        da, db = doc["apps"]
        self.assertEqual(da["application"], "Alpha App"); self.assertEqual(db["application"], "Beta App")
        self.assertEqual(da["score"], 100, da["score_parts"])
        self.assertEqual(db["score"], 100 - 15 - 10, db["score_parts"])  # no fresh-session proof, no PR
        self.assertFalse(doc["realtime"])
        self.assertIn("collected_at", doc)

    def test_tampered_standard_loses_validate_points_and_is_reported(self):
        a = self.make_repo("alpha")
        shutil.copy(os.path.join(HERE, "test_aeos.py"), os.path.join(a, "scripts/aeos/test_aeos.py"))
        open(os.path.join(a, "EENDIGO_AEOS.md"), "a").write("\nweakened\n")
        d = self.collect([{"dir": a}])["apps"][0]
        self.assertFalse(d["validate"]["ok"]); self.assertEqual(d["score_parts"]["validate_ok"], 0)

    def test_open_p1_and_blocker_remove_the_clean_points(self):
        a = self.make_repo("alpha")
        shutil.copy(os.path.join(HERE, "test_aeos.py"), os.path.join(a, "scripts/aeos/test_aeos.py"))
        open(os.path.join(a, ".engineering/BACKLOG.md"), "a").write("| T-ALPHA-1 | core | bug | IN PROGRESS | UNVERIFIED | no | P1 | - | - |\n")
        d = self.collect([{"dir": a}])["apps"][0]
        self.assertEqual(d["backlog"]["open_p0_p1"], 1); self.assertEqual(d["score_parts"]["no_open_p0_p1_or_blockers"], 0)

    def test_unstable_or_unknown_pr_does_not_earn_the_mergeable_points(self):
        a = self.make_repo("alpha")
        shutil.copy(os.path.join(HERE, "test_aeos.py"), os.path.join(a, "scripts/aeos/test_aeos.py"))
        for state in ("unstable", "unknown", "dirty"):
            pr = {"state": "open", "draft": True, "mergeable_state": state, "html_url": "https://github.com/o/r/pull/1"}
            d = self.collect([{"dir": a, "pr": pr, "fresh_session": {"passed": 1, "total": 1}}])["apps"][0]
            self.assertEqual(d["score_parts"]["draft_pr_open_and_mergeable"], 0, state)

    def test_unenrolled_directory_scores_zero(self):
        e = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, e, True)
        d = self.collect([{"dir": e}])["apps"][0]
        self.assertEqual(d["score"], 0); self.assertEqual(d["status"], "NOT ENROLLED")

class TestCanonicalDocument(unittest.TestCase):
    """Documentation checks: the canonical text must keep its safety clauses."""
    def setUp(self):
        self.t = open(os.path.join(PKG, "EENDIGO_AEOS.md"), encoding="utf-8").read()

    def test_required_clauses(self):
        for s in ["AEOS-VERSION: 1.0.0", "ONE message", "Autonomy is not approval", "Each release has its own approval",
                  "Never claim", "RELEASED` only after a real production deploy", "No mandate, no work",
                  "never redirects a session to another application", "UNVERIFIED", "exact words", "3 failures"]:
            self.assertIn(s.lower().replace("`", ""), self.t.lower().replace("`", ""), s)

    def test_no_deploy_authority_granted(self):
        self.assertIn("does **not** use that authority unless the current user message repeats it", self.t)


if __name__ == "__main__":
    unittest.main(verbosity=1)
