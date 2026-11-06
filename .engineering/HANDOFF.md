# HANDOFF — exact recovery instructions
1. Run `python3 scripts/aeos/aeos.py resume`.
2. Compare the checkpoint SHA with `git log -1`.
3. Continue with the checkpoint's "Next task". Do not restart a broad audit.

Overwritten by `aeos.py checkpoint`:

<!-- CHECKPOINT:BEGIN -->
- Time: 2026-11-06 15:11 UTC
- Repo: 1903978-prog/anti-hacker
- Branch: claude/project-thread-gdv0ew
- SHA: a61fea5
- Task done: T-SECVAL-1 Database column measured (PR #48)
- Next task: Wait for app threads' /api/secval/db-health drafts; morning summary to Livio
- Changes: server/health/dbcheck.ts, score.ts, migrations v5, docs/database-check.md
- Tests run: npm run verify 257 tests + page check
- Result: VERIFIED
- Blockers: Live deploy, SECVAL_DBCHECK_TOKEN on secval and apps: Livio
- Approvals held: Draft PR only (D-002); no merge/deploy/migration
- Release restrictions: HOLD (CLAUDE.md rule 2): no PR, no push to a remote, no deploy unless Livio writes the exact words 'ship it'; until then commit locally only; HOLD: warn Livio before any action that spends GitHub Actions minutes or Render compute; HOLD: run `npm run verify` before every push; never push red or unrun; Safety layer (policy engine, allowlist, kill switch, audit trail) can never be bypassed; Lenovo: only qwen3:8b with keep_alive
<!-- CHECKPOINT:END -->
