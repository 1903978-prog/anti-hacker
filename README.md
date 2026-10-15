# secval

An authorized continuous security-validation platform — a self-service
scanner for **my own assets only**. The governance/safety layer is built and
tested before any scanning capability exists.

> Status: **Phase 1 (governance spine) complete.** No scanning capability
> exists yet. See `CLAUDE.md` for standing rules and safety invariants.

## Phase 1 — what's here

- **Policy engine** (`server/governance/policy.ts`) — the single gate every
  scan must pass. Independent of scanning code, cannot be bypassed, and
  **fails closed**: anything unknown or erroring is denied.
- **Ownership allowlist** (`server/ownership/allowlist.ts`) — a URL not on the
  list can never be scanned. Seeded with my domains, all unproven until
  verified. A domain cannot become active-eligible before ownership is proven.
- **Proof of ownership** (`server/ownership/proof.ts`) — prove a domain via a
  DNS TXT record or a token file on the site; the tool verifies it.
- **Resource limits** (`server/governance/limits.ts`) — hard caps on
  requests/second, total requests, runtime, and retained data; zero
  data-mutating operations by default.
- **Immutable audit trail** (`server/audit/log.ts`) — every action is logged
  append-only; database triggers reject any edit or delete.
- **Kill switch** (`server/governance/killswitch.ts`) — one switch halts all
  scans; while engaged the policy engine denies every request.

## Run

```bash
npm install
npm start          # http://localhost:3000  (health at /health)
npm test           # vitest — the safety-layer tests
npm run typecheck
```

The SQLite store lives under `DATA_DIR` (default `./data`) and holds the
allowlist, scan history, and audit trail.

## HTTP endpoints (Phase 1)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + kill-switch state |
| GET | `/api/allowlist` | list allowlisted domains |
| POST | `/api/allowlist` | add a domain (unproven) |
| DELETE | `/api/allowlist/:domain` | remove a domain |
| POST | `/api/allowlist/:domain/challenge` | issue an ownership challenge token |
| POST | `/api/allowlist/:domain/verify` | verify ownership (`dns-txt` or `token-file`) |
| POST | `/api/allowlist/:domain/active-eligible` | toggle active-eligibility (requires proof) |
| GET | `/api/audit` | read the append-only audit trail |
| POST | `/api/kill-switch/engage` · `/release` | halt / resume all scans |
| POST | `/api/scan/preflight` | ask the policy engine for approval (runs nothing) |

## Next (Phase 2)

A passive-only scanner built on top of this spine (security headers, TLS
config, etc.) with a paste-a-URL UI and allowlist management.
