# HANDOFF — exact recovery instructions
1. Run `python3 scripts/aeos/aeos.py resume`.
2. Compare the checkpoint SHA with `git log -1`.
3. Continue with the checkpoint's "Next task". Do not restart a broad audit.

Overwritten by `aeos.py checkpoint`:

<!-- CHECKPOINT:BEGIN -->
- Time: 2026-11-05 12:31 UTC
- Repo: 1903978-prog/anti-hacker
- Branch: claude/fervent-euler-yurhdu
- SHA: 44c9ceb
- Task done: Install AEOS 1.0.0 (docs/config only, no business logic)
- Next task: Await user mandate; no backlog assigned
- Changes: none
- Tests run: test_aeos.py 15 tests; validate OK
- Result: PARTIAL
- Blockers: none
- Approvals held: none: no merge/deploy approved
- Release restrictions: HOLD (CLAUDE.md rule 2): no PR, no push to a remote, no deploy unless Livio writes the exact words 'ship it'; until then commit locally only; HOLD: warn Livio before any action that spends GitHub Actions minutes or Render compute; HOLD: run `npm run verify` before every push; never push red or unrun; Safety layer (policy engine, allowlist, kill switch, audit trail) can never be bypassed; Lenovo: only qwen3:8b with keep_alive
<!-- CHECKPOINT:END -->
