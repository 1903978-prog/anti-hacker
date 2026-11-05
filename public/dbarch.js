/* global api, el, esc */
// Database Architecture & Integrity tab. Reads /api/dbarch (scores measured by
// secval from read-only catalog queries). N/V = no verified evidence; it is
// never drawn as a zero or as green.
let dbView = null;
let dbDetails = {};
let dbSelected = null; // {kind:'cell'|'finding'|'app', ...}
const DB_APPS_SHORT = { atlas: "ATLAS", "lm-op-model": "LM OpModel", nexus: "Nexus" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Dates are always written like "03 Nov 2026".
function dbDate(iso, withTime) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const s = `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return withTime ? `${s} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC` : s;
}
const dbNum = (v) => (v === null || v === undefined ? "N/V" : (Math.round(v * 10) / 10).toFixed(1));
function dbTone(score, target) {
  if (score === null || score === undefined) return "nv";
  if (score >= target) return "good";
  return score >= 6 ? "mid" : "bad";
}
const dbDelta = (d) => (d === null || d === undefined ? "no earlier snapshot" : d === 0 ? "no change" : `${d > 0 ? "▲ +" : "▼ "}${Math.round(d * 10) / 10} since previous`);
const dbBadge = (state) => `<span class="badge dbs-${esc(state)}">${esc(state)}</span>`;

function spark(history, key) {
  const pts = history.filter((h) => h[key] !== null);
  if (pts.length < 2) return `<span class="note">Trend needs at least 2 verified scans.</span>`;
  const w = 140, h = 32;
  const xs = pts.map((_, i) => (i / (pts.length - 1)) * (w - 4) + 2);
  const ys = pts.map((p) => h - 2 - (p[key] / 10) * (h - 4));
  const d = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Score trend over ${pts.length} verified scans, latest ${dbNum(pts[pts.length - 1][key])} of 10"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
}

function dbCard(a) {
  const A = a.headline.architecture, R = a.headline.readiness;
  const hist = a.historical;
  return `<div class="dbcard" data-app="${esc(a.app)}">
    <div class="dbcard-h"><button class="linklike" data-open-app="${esc(a.app)}"><strong>${esc(a.label)}</strong></button> ${a.configured ? "" : '<span class="badge">not connected</span>'}</div>
    <div class="dbpair">
      <div><div class="dbl">Architecture quality</div><div class="dbn ${dbTone(A.score, A.target)}">${dbNum(A.score)}<small>/10</small></div>
        <div class="note">target ${A.target} · ${dbBadge(A.state)}<br>coverage ${Math.round(A.coverage * 100)}%<br>${esc(dbDelta(A.delta))}</div></div>
      <div><div class="dbl">Remediation readiness</div><div class="dbn ${dbTone(R.score, R.target)}">${dbNum(R.score)}<small>/10</small></div>
        <div class="note">target ${R.target} · ${dbBadge(R.state)}<br>coverage ${Math.round(R.coverage * 100)}%<br>${esc(dbDelta(R.delta))}</div></div>
    </div>
    <div class="note">Last successful scan: ${esc(dbDate(a.lastScanAt, true))}${a.lastError ? ` · <span class="sev high">last attempt failed: ${esc(a.lastError)}</span>` : ""}</div>
    <div class="note"><span class="tag">historical manual baseline</span> architecture ${hist.architecture}/10 on ${esc(dbDate(hist.asOf))} (reference only, not a measurement)</div>
    <div class="note">7-day: ${dbNum(A.trend7)} · 30-day: ${dbNum(A.trend30)} · findings P0 ${a.findingCounts.P0 || 0} / P1 ${a.findingCounts.P1 || 0} / P2 ${a.findingCounts.P2 || 0}</div>
    <div>${spark(a.history, "architecture")}</div>
  </div>`;
}

function dbCellBtn(a, c, group) {
  const tone = dbTone(c.effective, c.target);
  const ov = c.override ? ' <span class="tag">override</span>' : "";
  return `<button class="dbcell ${tone}" data-cell="${esc(group)}:${esc(c.key)}" data-app="${esc(a.app)}" aria-label="${esc(c.label)}, ${esc(a.label)}: ${esc(dbNum(c.effective))} of 10, ${esc(c.state)}">
    <span class="dbapp">${esc(DB_APPS_SHORT[a.app])}</span>
    <span class="dbv">${dbNum(c.effective)}<small>${c.effective === null ? "" : "/10"}</small></span>
    <span class="dbst">${esc(c.state)}${ov}</span>
    <span class="dbd">${c.delta === null ? "–" : c.delta === 0 ? "±0" : (c.delta > 0 ? "+" : "") + Math.round(c.delta * 10) / 10}</span>
  </button>`;
}

function dbMatrix(apps, group, rows) {
  const head = `<div class="dbrow dbhead"><div class="dblabel">Criterion</div>${apps.map((a) => `<div>${esc(DB_APPS_SHORT[a.app])}</div>`).join("")}</div>`;
  const body = rows.map((r) => {
    const cells = apps.map((a) => {
      const list = group === "r" ? a.readinessRows : a.architectureCriteria;
      const c = list.find((x) => x.key === r.key);
      return c ? dbCellBtn(a, c, group) : `<div class="dbcell nv"><span class="dbapp">${esc(DB_APPS_SHORT[a.app])}</span><span class="dbv">N/V</span><span class="dbst">UNVERIFIED</span></div>`;
    }).join("");
    return `<div class="dbrow"><div class="dblabel">${esc(r.label)}${r.weight ? ` <span class="note">weight ${r.weight}</span>` : ""}</div>${cells}</div>`;
  }).join("");
  return head + body;
}

function dbCellDetail(appKey, group, key) {
  const a = dbView.apps.find((x) => x.app === appKey);
  const c = (group === "r" ? a.readinessRows : a.architectureCriteria).find((x) => x.key === key);
  if (!c) return "";
  const subs = c.subscores.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.earned === null ? "N/V" : esc(s.earned)} / ${esc(s.max)}</td><td>${esc(s.calculation)}<br><span class="note">inputs: ${esc(JSON.stringify(s.inputs))}</span><br><span class="note">source: ${esc(s.source)}</span></td></tr>`).join("");
  return `<h3>${esc(c.label)} · ${esc(a.label)}</h3>
    <p>Measured: <strong>${dbNum(c.measured)}</strong>/10 ${dbBadge(c.state)} · coverage ${Math.round(c.coverage * 100)}% · target ${c.target} · ${esc(dbDelta(c.delta))}<br>
    Last verification with evidence: ${esc(dbDate(c.lastVerifiedAt, true))}</p>
    ${c.capReason ? `<p class="sev medium">Cap applied: ${esc(c.capReason)}</p>` : ""}
    ${c.override ? `<p><span class="tag">time-bound override</span> value ${esc(c.override.value)} by ${esc(c.override.approvedBy)} since ${esc(dbDate(c.override.since))}, expires ${esc(dbDate(c.override.expiresAt))}. Reason: ${esc(c.override.reason)}. The raw measurement above is unchanged.</p>` : ""}
    <div class="tablewrap"><table><thead><tr><th>Check</th><th>Points</th><th>Calculation, inputs, source</th></tr></thead><tbody>${subs}</tbody></table></div>
    ${c.open.length ? `<p><strong>Still open</strong></p><ul>${c.open.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : "<p>Nothing open.</p>"}`;
}

function dbAppDetail(appKey) {
  const a = dbView.apps.find((x) => x.app === appKey);
  const d = dbDetails[appKey];
  const rec = a.reconcile.map((r) => `<tr><td>${esc(r.metric)}</td><td>${esc(r.reference)}</td><td>${r.live === null ? "N/V" : esc(r.live)}</td><td>${r.matches === null ? "N/V" : r.matches ? "matches" : "differs"}</td></tr>`).join("");
  const neon = a.neon ? `Production branch: <code>${esc(a.neon.branchName ?? "unknown")}</code> · protected: ${a.neon.protected === null ? "N/V" : a.neon.protected ? "yes" : "no"} · history retention: ${a.neon.historyRetentionSeconds === null ? "N/V" : esc(a.neon.historyRetentionSeconds / 3600) + " h"}` : "Neon settings not readable (no API token or Neon unreachable): N/V";
  const inv = d && d.detail ? d.detail.inventory : [];
  const invRows = inv.slice(0, 60).map((i) => `<tr><td>${esc(i.sourceTable)}.${esc(i.sourceColumn)}</td><td>${i.targetTable ? esc(i.targetTable) + "." + esc(i.targetColumn) : "none found"}</td><td>${esc(i.cardinality)}</td><td>${esc(i.classification)}</td><td>${i.orphans === null ? "N/V" : esc(i.orphans)}</td><td>${esc(i.criticality)}</td></tr>`).join("");
  return `<h3>${esc(a.label)}</h3><p>${neon}</p>
    <p class="note">Neon project <code>${esc(a.projectId)}</code>. Schema change since approved baseline: ${esc(a.schemaChange ?? "N/V")}.</p>
    ${dbPerms(d)}
    <p><strong>Baseline counts: manual (05 Nov 2026) against the latest live scan</strong></p>
    <div class="tablewrap"><table><thead><tr><th>Metric</th><th>Manual</th><th>Live</th><th>Result</th></tr></thead><tbody>${rec || '<tr><td colspan="4">No live scan yet: N/V</td></tr>'}</tbody></table></div>
    <p><strong>FK candidate inventory</strong> (${inv.length} columns${inv.length > 60 ? ", first 60 shown" : ""}). A name ending in _id is never treated as proof of a missing foreign key.</p>
    <div class="tablewrap"><table><thead><tr><th>Source</th><th>Possible target</th><th>Cardinality</th><th>Class</th><th>Orphans</th><th>Criticality</th></tr></thead><tbody>${invRows || '<tr><td colspan="6">None</td></tr>'}</tbody></table></div>`;
}

function dbPerms(d) {
  const p = d && d.detail ? d.detail.permissions : null;
  if (!p) return '<p><strong>Monitoring login permissions:</strong> N/V (no verified scan yet)</p>';
  const rows = p.checks.map((c) => `<tr><td>${esc(c.label)}</td><td>${c.ok === null ? "N/V" : c.ok ? "pass" : "FAIL"}</td><td>${esc(c.detail)}</td></tr>`).join("");
  return `<p><strong>Monitoring login: effective permissions</strong> (checked ${esc(dbDate(p.checkedAt, true))}; least privilege: ${p.leastPrivilege === null ? "N/V" : p.leastPrivilege ? "yes" : "NO, scans are refused"})</p>
    <div class="tablewrap"><table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function dbFindings() {
  const fa = el("dbFilterApp").value, fs = el("dbFilterSev").value;
  const items = [];
  for (const a of dbView.apps) {
    const d = dbDetails[a.app];
    if (!d || !d.detail) continue;
    for (const r of d.detail.recommendations) items.push({ ...r, appLabel: a.label });
  }
  const shown = items.filter((r) => (fa === "all" || r.app === fa) && (fs === "all" || r.priority === fs));
  if (!shown.length) return `<div class="note">${items.length ? "No findings match the filters." : "No verified findings yet (N/V until a scan has run)."}</div>`;
  return `<div class="tablewrap"><table><thead><tr><th>Priority</th><th>App</th><th>Issue</th><th>Target</th></tr></thead><tbody>${shown.map((r) =>
    `<tr><td><span class="sev ${r.priority === "P0" ? "high" : r.priority === "P1" ? "medium" : "low"}">${esc(r.priority)}</span></td><td>${esc(r.appLabel)}</td><td><button class="linklike" data-finding="${esc(r.app)}|${esc(r.id)}">${esc(r.issue)}</button></td><td>${esc(r.target)}</td></tr>`).join("")}</tbody></table></div>`;
}

function dbFindingDetail(appKey, id) {
  const r = dbDetails[appKey]?.detail?.recommendations.find((x) => x.id === id);
  if (!r) return "";
  const f = (l, v) => `<tr><th>${l}</th><td>${esc(v)}</td></tr>`;
  return `<h3>${esc(r.issue)}</h3><div class="tablewrap"><table><tbody>${f("Priority", r.priority)}${f("Target", r.target)}${f("Evidence", r.evidence)}${f("Root cause", r.rootCause)}${f("Proposed correction", r.correction)}${f("Expected improvement", r.expectedImprovement)}${f("Risk and effort", r.riskEffort)}${f("Migration or code change", r.migrationOrCode)}${f("Independent verification test", r.verificationTest)}${f("Rollback", r.rollback)}${f("Owner", r.owner)}</tbody></table></div>
    ${r.draftSql ? `<p><strong>Draft SQL proposal</strong> (stored text only; secval never runs it)</p><pre class="dbsql">${esc(r.draftSql)}</pre>` : ""}`;
}

function dbAlerts() {
  const list = dbView.alerts;
  if (!list.length) return '<div class="note">No alerts.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>When</th><th>App</th><th>Level</th><th>Alert</th></tr></thead><tbody>${list.slice(0, 15).map((a) =>
    `<tr><td>${esc(dbDate(a.created_at, true))}</td><td>${esc(DB_APPS_SHORT[a.app] || a.app)}</td><td><span class="sev ${a.severity === "P0" ? "high" : "medium"}">${esc(a.severity)}</span></td><td>${esc(a.message)}</td></tr>`).join("")}</tbody></table></div>`;
}

function dbRender() {
  if (!dbView) return;
  const apps = dbView.apps;
  el("dbCards").innerHTML = apps.map(dbCard).join("");
  el("dbRemed").innerHTML = dbMatrix(apps, "r", dbView.readinessRows);
  el("dbArch").innerHTML = dbMatrix(apps, "a", dbView.weights);
  el("dbFindings").innerHTML = dbFindings();
  el("dbAlerts").innerHTML = dbAlerts();
  el("dbMeta").textContent = `Calculation ${dbView.calcVersion} · Quick Refresh ${dbView.cadence.quick} · Deep Audit ${dbView.cadence.deep} · scheduled checks, not continuous streaming.`;
  dbShowDetail();
}

function dbShowDetail() {
  const box = el("dbDetail");
  if (!dbSelected) { box.innerHTML = '<div class="note">Click any score, app or finding to see what was checked and what is still open.</div>'; return; }
  box.innerHTML = dbSelected.kind === "cell" ? dbCellDetail(dbSelected.app, dbSelected.group, dbSelected.key)
    : dbSelected.kind === "finding" ? dbFindingDetail(dbSelected.app, dbSelected.id) : dbAppDetail(dbSelected.app);
}

async function loadDbarch() {
  const { ok, body } = await api("/api/dbarch");
  if (!ok) { el("dbMsg").textContent = "Could not load the database scorecard."; return; }
  dbView = body;
  await Promise.all(body.apps.map(async (a) => {
    const r = await api(`/api/dbarch/${encodeURIComponent(a.app)}/detail`);
    if (r.ok) dbDetails[a.app] = r.body;
  }));
  el("dbMsg").textContent = "";
  dbRender();
}

async function dbRefresh(mode) {
  for (const id of ["dbQuick", "dbDeep", "dbConn"]) el(id).disabled = true;
  el("dbMsg").textContent = mode === "deep" ? "Running Deep Audit (read-only)…" : "Running Quick Refresh (read-only)…";
  const { ok, body } = await api("/api/dbarch/refresh", { method: "POST", body: JSON.stringify({ mode }) });
  for (const id of ["dbQuick", "dbDeep", "dbConn"]) el(id).disabled = false;
  if (!ok) { el("dbMsg").textContent = "Refresh failed."; return; }
  const bad = body.outcomes.filter((o) => ["error", "unconfigured"].includes(o.status));
  el("dbMsg").textContent = bad.length ? bad.map((o) => `${DB_APPS_SHORT[o.app]}: ${o.message}`).join(" · ") : "Refreshed.";
  await loadDbarch();
}

async function dbConnTest() {
  el("dbConn").disabled = true;
  el("dbMsg").textContent = "Testing each connection from this server (read-only)…";
  const { ok, body } = await api("/api/dbarch/connectivity", { method: "POST", body: "{}" });
  el("dbConn").disabled = false;
  if (!ok) { el("dbMsg").textContent = "Connection test failed to run."; return; }
  el("dbMsg").textContent = body.reports.every((r) => r.ok) ? "All connections work and are read-only." : "At least one connection needs attention (see below).";
  el("dbConnOut").innerHTML = body.reports.map((r) => `<div class="app"><strong>${esc(r.label)}</strong> ${r.ok ? '<span class="badge ok">ready</span>' : '<span class="badge">needs attention</span>'}
    <ul>${r.stages.map((s) => `<li>${s.ok === null ? "N/V" : s.ok ? "pass" : "FAIL"}: ${esc(s.label)} <span class="note">${esc(s.detail)}</span></li>`).join("")}</ul></div>`).join("");
}
el("dbConn").onclick = dbConnTest;

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-cell],[data-finding],[data-open-app]");
  if (!t || !el("dbCards")) return;
  if (t.dataset.cell) { const [group, key] = t.dataset.cell.split(":"); dbSelected = { kind: "cell", app: t.dataset.app, group, key }; }
  else if (t.dataset.finding) { const [app, id] = t.dataset.finding.split("|"); dbSelected = { kind: "finding", app, id }; }
  else dbSelected = { kind: "app", app: t.dataset.openApp };
  dbShowDetail();
  el("dbDetail").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
el("dbQuick").onclick = () => dbRefresh("quick");
el("dbDeep").onclick = () => dbRefresh("deep");
el("dbFilterApp").onchange = el("dbFilterSev").onchange = () => { if (dbView) el("dbFindings").innerHTML = dbFindings(); };
el("dbAttestBtn").onclick = async () => {
  const value = el("dbAttValue").value === "" ? null : Number(el("dbAttValue").value);
  const { ok, body } = await api("/api/dbarch/attest", { method: "POST", body: JSON.stringify({
    app: el("dbAttApp").value, key: el("dbAttKey").value, value, detail: el("dbAttDetail").value || undefined,
    reason: el("dbAttReason").value, expiresInDays: Number(el("dbAttDays").value) || 30 }) });
  el("dbAttMsg").textContent = ok ? "Recorded. It is time-bound and shown next to the raw measurement." : `Not saved: ${(body.issues || [body.error]).join("; ")}`;
  if (ok) loadDbarch();
};
