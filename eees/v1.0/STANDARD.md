# EEES v1.0 — Eendigo Engineering Excellence Standard

Version 1.0.0 · adopted 12 Nov 2026 · approved by Livio (project chat, 12 Nov 2026 02:18 UTC).
This file is the single authoritative copy. Apps adopt it by reference (see `eees/README.md`); they never copy or change the definitions.
Machine-readable registry: `eees/v1.0/criteria.json` (30 dimensions, 102 checks, weights, ceilings, gates). File formats: `eees/v1.0/schema/*.schema.json`.

Part A is Livio's specification, word for word. Part B says exactly how the scoring engine (`server/eees/engine.ts`) applies it, so any score can be recomputed by hand.

---

## Part A — Specification (verbatim)

Implement a permanent, evidence-based, universal engineering quality scorecard for every Eendigo application.
The objective is to assess how close each application is to being a perfectly safe, reliable, accurate, functional, maintainable and interconnected production system.
Do not create a superficial AI-generated scorecard.

### 1. Mandatory 30 dimensions and weights

Score each dimension from 0 to 10.

**Data Architecture & Interoperability — 21%**
1. Database architecture and migrations — 4%
2. Data integrity and concurrency — 4%
3. Data quality and provenance — 3%
4. Data flows and freshness — 4%
5. Integration and API contracts — 3%
6. Cross-application consistency — 3%

**Security, Privacy & Governance — 24%**
7. Identity and authentication — 4%
8. Authorization and data isolation — 5%
9. Secrets, encryption and key management — 4%
10. Application, API and infrastructure security — 5%
11. Privacy and data lifecycle — 3%
12. Audit trails, approvals and governance — 3%

**Business Functionality & Intelligence — 22%**
13. Functional completeness and correctness — 4%
14. Business processes and workflow orchestration — 4%
15. Protocols, rules and state transitions — 4%
16. Financial and domain-specific correctness — 4%
17. AI quality, grounding and agent safety — 3%
18. UX, accessibility and usability — 3%

**Reliability & Operations — 20%**
19. Availability and service-level objectives — 4%
20. Performance, scalability and capacity — 3%
21. Resilience and graceful degradation — 3%
22. Observability, monitoring and alerts — 3%
23. Backups, disaster recovery and recoverability — 5%
24. Background jobs and operational automation — 2%

**Software Engineering & Delivery — 13%**
25. Architecture, code quality and maintainability — 2%
26. Automated testing and independent QA — 3%
27. CI/CD, deployment and release safety — 3%
28. Configuration and environment consistency — 2%
29. Dependencies and software supply chain — 2%
30. Documentation, ownership and operational readiness — 1%

Total weight: 100%.

### 2. Mandatory evidence standards

Use actual code inspection, database metadata, CI runs, integration tests, production telemetry, security checks, browser tests, restore drills and independently verified results.
Every dimension must have:
- A documented definition of what 10/10 means.
- Explicit requirements and acceptance tests.
- Number of applicable required checks.
- Number verified.
- Number failed.
- Number unknown.
- Raw score.
- Evidence-adjusted score.
- Links to reproducible evidence.
- Evidence date.
- Verified environment.
- Independent reviewer where appropriate.
- Open defects and severity.
- Recommended corrections.

Do not assume a passing test suite covers untested functionality.
Do not treat an assertion by a coding agent as independent verification.

### 3. Scoring rules

0 = No implementation or no reliable evidence.
1–2 = Critical failure or severe incompleteness.
3–4 = Partial implementation with major gaps.
5–6 = Development functionality verified mainly through synthetic tests.
7–8 = Realistic end-to-end validation, negative testing and documented risks.
9 = Verified production functionality with measurements.
10 = Independently verified, sustained, fully controlled and operationally proven.

Apply evidence ceilings:
- Synthetic tests alone: maximum 6.
- Production-like tests without production verification: maximum 8.
- Production verification without sufficient independent and sustained evidence: maximum 9.

Unknown must remain UNKNOWN, not PASS.
An UNKNOWN dimension receives zero in the conservative assured score until evidence exists.
Allow N/A only with documented justification and reviewer approval. Redistribute its weight within the same domain. Never use N/A to conceal missing functionality.
Use risk-adjusted requirements: critical financial and sensitive-data applications require stronger proof than simple public content pages.

### 4. Mandatory hard gates

A confirmed exploitable critical security flaw, unauthorized client-data access or active exposed credential caps assurance at 3/10 and blocks release.
Critical data corruption, incorrect financial posting or failed recovery of critical data caps assurance at 5.9/10 and blocks release.
Unresolved material P1 issues cap assurance at 7.9/10.
No complete production-like end-to-end validation caps assurance at 7.9/10.
No independent production verification caps assurance at 8.0/10.
No sustained production monitoring or independent final QA caps assurance at 8.9/10.
No application may be declared RELEASE READY while a mandatory security, database, migration, approval or recovery gate is failing.
A high weighted average never overrides a failed gate.

### 5. Cross-application assessment

Build an inventory of every important data flow among applications.
For each flow document:
- Producer and consumer.
- Source-of-truth ownership.
- Record identity and mapping.
- Authentication and authorization.
- API/protocol versions.
- Data schema.
- Transformation rules.
- Update frequency and freshness SLO.
- Delivery semantics.
- Idempotency and replay behavior.
- Error and retry handling.
- Reconciliation method.
- Monitoring.
- Recovery procedure.
- End-to-end test evidence.

Evaluate cross-application journeys independently.
If a critical dependency fails, reflect its impact in the consuming application's score.
Do not assign full credit to an application simply because its local API returns HTTP 200.

### 6. Reference standards

Map relevant requirements, as appropriate, to:
- NIST Cybersecurity Framework 2.0.
- NIST Secure Software Development Framework.
- OWASP ASVS 5.0.
- OWASP API security guidance.
- OWASP LLM Top 10 (2025).
- NIST AI Risk Management Framework.
- Google SRE SLI/SLO principles.
- DORA software delivery metrics.
- WCAG 2.2 AA.
- OpenTelemetry observability practices.

Use the applicable requirements, not superficial claims of certification.

### 7. Application inventory

Apply EEES to:
- ATENA core application.
- ATENA Pitch Architect.
- ATENA Negotiation Intelligence.
- Nexus / Project Guard.
- LM OpModel.
- 10bonds.
- Secval.
- Diagnostic Platform.
- Lenovo/Ollama infrastructure.
- Eendigo.com.
- Any additional active production application discovered during inventory.

Distinguish applications, services and subsystems to avoid double-counting the same defects.

### 8. Central dashboard

Reuse the existing Secval or engineering control infrastructure where appropriate.
Present:
- Application name.
- Exact production version.
- Overall assured score /10.
- Five domain scores.
- Thirty individual dimension scores.
- Audit coverage percentage.
- Production confidence.
- Critical findings.
- Date of last independent verification.
- Trend.
- Release status.
- Top three recommended improvements.

Allow clicking each score to inspect evidence, failed tests, unresolved risks and exact corrective actions.
No decorative progress bars without actual underlying measurements.

### 9. Automated evaluation

Automate all safely automatable checks.
Examples:
- CI test outcomes.
- Security dependency scanning.
- Route authorization inventory.
- Database constraints and indexes.
- Migration rehearsal results.
- Production version verification.
- Backup freshness and restore evidence.
- Webhook and synchronization freshness.
- Application error rates.
- Failed background jobs.
- Contract tests.
- Browser end-to-end tests.
- Performance SLO compliance.
- AI factual evaluation benchmarks.

Do not modify production data while performing an audit.
Do not run destructive penetration tests or load tests against live services without specific authorization.
Security-sensitive inspection must use least-privilege access.

### 10. Improvement engine

For every criterion below 9.5, determine:
- Why the score is low.
- Whether the issue is real or merely unverified.
- Which defects contribute to the gap.
- Business impact.
- Estimated implementation effort.
- Risk of the proposed change.
- Expected measurable improvement.
- Correct owner and existing workstream.
- Tests needed to prove closure.

Prioritize by business risk and safety impact, not simply by which score can be increased most easily.
Create or update existing engineering tasks.
Do not spawn duplicate project sessions.
Do not automatically change production systems.

### 11. Release governance

Preserve the existing exact-SHA approval requirements.
Development fixes and draft pull requests may proceed autonomously in isolated environments.
Production merges, releases, schema migrations, configuration changes, credential operations, new paid infrastructure and destructive actions require separate explicit authorization.
Never inflate a release-readiness score because its PR is ready.
Verify production state independently after an authorized release.

### 12. Expected output

Produce:
1. A versioned EEES v1.0 definition.
2. A machine-readable registry of all 30 criteria.
3. Reproducible acceptance tests for each applicable criterion.
4. An evidence-backed baseline for each application.
5. A consolidated engineering quality dashboard.
6. A prioritized remediation register.
7. A clear distinction between implemented, tested, release-approved and verified-live functionality.
8. A mechanism for daily, weekly and monthly reassessment.

Do not fabricate scores when verification is unavailable.
Do not claim applications are 10/10 based on synthetic tests or completed development tasks.
Continue implementing all safe automation and assessment functionality that does not require production authorization.
Keep progress updates concise and maintain full technical evidence in the engineering register.
Final success condition: Every Eendigo application has a transparent, independently auditable quality rating that identifies precisely what is working, what is not, what remains unknown, and what must be improved to reach genuine engineering excellence.

---

## Part B — How the engine applies it (engineering decisions, v1.0.0)

These are implementation choices made where the specification leaves the method open. Changing any of them is a new standard version.

1. **Checks.** Each dimension has 3 or 4 required checks in `criteria.json`, each with an acceptance test, method, cadence and reference-standard mapping. 102 checks in total.
2. **Check credit.** verified = ceiling of its evidence level ÷ 10 (synthetic 0.6, prodlike 0.8, production 0.9, independent-sustained 1.0); failed = 0; UNKNOWN = 0; N/A = left out.
3. **Dimension scores.** raw = 10 × verified ÷ applicable (no ceilings). Evidence-adjusted = 10 × sum of credits ÷ applicable. A dimension whose applicable checks are all UNKNOWN is UNKNOWN and scores 0.
4. **What counts as UNKNOWN.** No entry; "verified" or "failed" without an evidence link; evidence whose only source is a coding agent's claim (`kind: agent-claim`); evidence older than the check's cadence (daily 2 days, weekly 9, monthly 35, per release 90). A missed reassessment therefore lowers the score by itself.
5. **Independence.** `independent-sustained` needs a named reviewer; without one it counts as production. Secval's monitors are separate from the apps they watch, but are capped at production (9) until a person reviews them over time.
6. **N/A.** Dimension N/A needs `justification` and `reviewer` in `dimensionsNA`; check N/A needs both on the check. Otherwise it is UNKNOWN. The dimension's weight is shared out inside its domain in proportion to the other dimensions' weights.
7. **Overall.** Weighted evidence-adjusted mean over the 30 dimensions → apply hard-gate caps → **assured score** (one decimal).
8. **Gates.** G1 fails on an open, confirmed-exploitable P0 security defect or a recorded fail. G2 fails on any P0 data, financial or recovery defect still present in production (including "fixed on a branch, not released") or a failed financial/recovery check measured on production. G3 fails on any open material P1. G1-G3 apply their cap only when failed; while unassessed they keep the app from being release ready. G4-G6 are about missing evidence, so their caps apply until a recorded pass with evidence exists.
9. **Release status.** BLOCKED if G1, G2 or a mandatory release gate (security, database, migration, approval, recovery) fails; NOT READY while any of them is unassessed; otherwise READY FOR RELEASE REVIEW. Never "released": that still needs Livio's exact-SHA approval and a post-deploy check.
10. **Audit coverage** = weight-weighted share of applicable checks that are known (verified or failed). **Production confidence** = weight-weighted share verified at production level or above (high ≥ 80%, medium ≥ 50%, low > 0, none).
11. **Cross-application flows** (`eees/flows.json`). The consumer's D04.2 fails if a consumed flow is failing, is UNKNOWN if any is unmeasured, and is verified at production level if all are healthy. D05.4 fails for producer and consumer while any of the flow's required fields is undocumented.
12. **Risk adjustment.** Tier critical (financial or sensitive data), standard, public. Tiers weight the ESII and decide how much proof the owner must collect; the ceilings and gates are the same for everybody.
13. **Subsystems** (ATENA Pitch Architect, ATENA Negotiation Intelligence) get their own scorecard but are excluded from the ESII so a defect is not counted twice; their defects are recorded once, on the app that owns the code.
14. **ESII portfolio index** = Σ(tier weight × assured) ÷ Σ tier weights over applications and infrastructure; weights critical 3, standard 2, public 1; an app with no evidence counts as 0.
15. **Improvement engine.** Every check below production-level credit in a dimension under 9.5 becomes an item: why, real defect / unverified / weak / expired, linked defects, impact, effort, risk, expected gain in assured points (if verified at production level), owner, proof needed. Order: confirmed failures on gate-related checks → other confirmed failures → unverified gate-related checks → expired evidence → the rest; inside a tier security/financial/recovery first, then domain risk (SEC, DATA, OPS, BIZ, ENG), then gain.
16. **Reassessment.** Daily: the Secval server recomputes on every page load and adds its live monitors (uptime, passive scan, CI, own backup drill). Daily/weekly/monthly: each check's cadence expires old evidence (rule 4). History: `npm run eees:record` appends a dated row per app (used for the trend). Monthly: the auditor reviews UNKNOWNs with each owner and the standard itself (new version if anything changes).
17. **Minimum production-readiness threshold** (an app is "production ready" only if all hold): assured score ≥ 8.0; release status READY FOR RELEASE REVIEW; no open P0 or material P1 defect; and the critical-workflow dimensions each ≥ 8.0 evidence-adjusted: tier critical D02, D07, D08, D09, D10, D12, D16, D23; tier standard D07, D08, D09, D10, D23; tier public D09, D10. "Verified" readiness additionally needs assured ≥ 9.0. These floors add weight to critical workflows without relaxing any gate.
18. **Existing evidence is reused, never replaced.** Baselines cite the existing audit registers (DB relationship audit, ATENA defect register, architecture audit, release dossiers) by path and date. EEES never overrides a stricter rule of an existing audit or app gate.

