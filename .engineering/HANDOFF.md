# HANDOFF — exact recovery instructions
1. Run `python3 scripts/aeos/aeos.py resume`.
2. Compare the checkpoint SHA with `git log -1`.
3. Continue with the checkpoint's "Next task". Do not restart a broad audit.

Overwritten by `aeos.py checkpoint`:

<!-- CHECKPOINT:BEGIN -->
- Time: 2026-11-07 01:37 UTC
- Repo: 1903978-prog/anti-hacker
- Branch: claude/project-thread-6o3ja2
- SHA: a2d8093
- Task done: 07 Nov audit; #48 re-verified (275 tests pass)
- Next task: On Livio's exact words 'ship it': merge #48 (head a2d8093), confirm Render deploy, check /api/version, message app threads
- Changes: .engineering/AUDIT-2026-11-07.md, TESTS.md
- Tests run: npm run verify: 275/275, page check pass
- Result: VERIFIED
- Blockers: A: release word not given; B: Render/Fly secrets only Livio; sandbox cannot reach secval.onrender.com
- Approvals held: D-001, D-002 draft PRs only
- Release restrictions: HOLD (CLAUDE.md rule 2): no PR, no push to a remote, no deploy unless Livio writes the exact words 'ship it'; until then commit locally only; HOLD: warn Livio before any action that spends GitHub Actions minutes or Render compute; HOLD: run `npm run verify` before every push; never push red or unrun; Safety layer (policy engine, allowlist, kill switch, audit trail) can never be bypassed; Lenovo: only qwen3:8b with keep_alive
<!-- CHECKPOINT:END -->
