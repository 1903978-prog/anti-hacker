# HANDOFF — exact recovery instructions
1. Run `python3 scripts/aeos/aeos.py resume`.
2. Compare the checkpoint SHA with `git log -1`.
3. Continue with the checkpoint's "Next task". Do not restart a broad audit.

Overwritten by `aeos.py checkpoint`:

<!-- CHECKPOINT:BEGIN -->
<!-- CHECKPOINT:END -->
