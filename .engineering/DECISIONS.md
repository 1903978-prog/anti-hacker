# DECISIONS
Approved business decisions only. One line each: ID, date, decision, who approved, applies to.

| ID | Date | Decision | Approved by | Applies to |
|---|---|---|---|---|
| D-001 | 06 Nov 2026 | Push commit b6e650b (and later AEOS commits) to the feature branch and open a DRAFT PR only; no merge, no deploy. Given in Livio's own words ("APPROVED — push Secval and open a DRAFT PR only"), not the exact phrase "ship it" that CLAUDE.md rule 2 names. Treated as sufficient for this one action; a fresh session still insists on the exact phrase for anything else. | Livio (chat) | Secval PR anti-hacker#47 only |
| D-002 | 06 Nov 2026 | Database ratings fix: "SHIP IT (draft only)". Push to the feature branch and open a DRAFT PR; no merge, deploy or migration. Standing: do not ask approval for ordinary development, testing or draft PR uploads. Does not authorise merging the AEOS draft PRs. | Livio (chat) | Secval database ratings PR; standing rule for draft PRs |
| AD-02 | 08 Nov 2026 | Auditor decision (replaces AD-01): the FK rule scores required-FK enforcement (requiredLinksValidated / requiredLinks); tablesInLinks and standaloneTables are diagnostic only; score capped at 89 while orphans, missing required FKs or open candidates exist. Implements Livio's 08 Nov relationship-audit order. | Livio's written order (thread 08 Nov 04:49 UTC) | Secval database score, all apps |
