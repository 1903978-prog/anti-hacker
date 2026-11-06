# HANDOFF — exact recovery instructions
1. Run `python3 scripts/aeos/aeos.py resume`.
2. Compare the checkpoint SHA with `git log -1`.
3. Continue with the checkpoint's "Next task". Do not restart a broad audit.

Overwritten by `aeos.py checkpoint`:

<!-- CHECKPOINT:BEGIN -->
- Time: 2026-11-06 09:28 UTC
- Repo: 1903978-prog/anti-hacker
- Branch: claude/fervent-euler-yurhdu
- SHA: efe5ecc
- Task done: Secval dashboard tab, collector data, register, fresh-session evidence
- Next task: Await review; no backlog assigned; production facts still UNVERIFIED
- Changes: none
- Tests run: npm run verify 247 tests + page check; test_aeos 22
- Result: VERIFIED
- Blockers: none
- Approvals held: push + draft PR only (D-001); no merge or deploy
- Release restrictions: HOLD (CLAUDE.md rule 2): no PR, no push to a remote, no deploy unless Livio writes the exact words 'ship it'; until then commit locally only; HOLD: warn Livio before any action that spends GitHub Actions minutes or Render compute; HOLD: run `npm run verify` before every push; never push red or unrun; Safety layer (policy engine, allowlist, kill switch, audit trail) can never be bypassed; Lenovo: only qwen3:8b with keep_alive
<!-- CHECKPOINT:END -->
