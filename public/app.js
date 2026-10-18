// secval control-plane UI. The secret token (the server's SECVAL_API_TOKEN)
// is typed once into a small box on the page (no pop-up). The server swaps it
// for a sign-in cookie that page scripts cannot read, so the token itself is
// never stored in this browser. Every API call carries that cookie.
let signedIn = false;
const NEED_TOKEN = "Needs your secret token: paste it in the box at the top, then press again.";

// A request was refused: show the token box with the reason and bring it into
// view. A "wrong token" reason stays on screen over the generic one.
const WRONG = "That secret token was wrong. Paste it again.";
function askForToken(message) {
  signedIn = false;
  el("tokenBox").hidden = false;
  if (message || el("tokenMsg").textContent !== WRONG) {
    el("tokenMsg").textContent = message || "Paste your secret token to see your data.";
  }
  el("tokenBox").scrollIntoView({ behavior: "smooth", block: "center" });
  el("tokenInput").focus({ preventScroll: true });
}

const api = (path, opts = {}) => {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  return fetch(path, { ...opts, headers, credentials: "same-origin" }).then((r) =>
    r.json().then((b) => {
      if (r.status === 401) askForToken();
      else if (r.ok && path.startsWith("/api/")) signedIn = true;
      return { ok: r.ok, status: r.status, body: b };
    }),
  );
};

// Sends the token once; on success the server sets the sign-in cookie.
async function signIn(token) {
  const r = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ token }),
  });
  return r.status;
}

// Earlier versions kept the token in browser storage. Use it once to sign in,
// then delete it, so nobody has to paste it again. It is only deleted once the
// server has answered (signed in, or the token is wrong); if the server is
// waking up or mid-deploy, it is kept and tried again on the next visit.
async function migrateOldToken() {
  let old = null;
  try { old = localStorage.getItem("secval_token"); } catch { /* none */ }
  if (!old) return;
  let status = 0;
  try { status = await signIn(old); } catch { /* network error: try next visit */ }
  if (status === 200 || status === 401) {
    try { localStorage.removeItem("secval_token"); } catch { /* nothing stored */ }
  }
}
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function refreshKillSwitch() {
  const { body } = await api("/health");
  const engaged = body.killSwitch === "engaged";
  el("ksDot").className = "dot" + (engaged ? " engaged" : "");
  el("ksLabel").textContent = engaged ? "kill switch ENGAGED" : "operational";
  el("ksBtn").textContent = engaged ? "Release" : "Engage kill switch";
  el("ksBtn").className = engaged ? "ghost" : "danger";
  el("ksBtn").dataset.engaged = engaged;
}
el("ksBtn").onclick = async () => {
  const engaged = el("ksBtn").dataset.engaged === "true";
  await api("/api/kill-switch/" + (engaged ? "release" : "engage"), { method: "POST", body: "{}" });
  refreshKillSwitch();
  refreshAudit();
};

async function refreshAllowlist() {
  const { ok, body } = await api("/api/allowlist");
  if (!ok) return;
  const rows = body
    .map(
      (e) => `
      <tr>
        <td><code>${esc(e.domain)}</code></td>
        <td>${e.ownershipProven ? '<span class="badge ok">proven</span>' : '<span class="badge">unproven</span>'}
            ${e.activeEligible ? '<span class="badge ok">active-eligible</span>' : ""}</td>
        <td class="right">
          ${
            e.ownershipProven
              ? `<button class="ghost" data-scan="${esc(e.domain)}">Scan</button>`
              : `<button class="ghost" data-challenge="${esc(e.domain)}">Get code</button>`
          }
          <button class="ghost" data-remove="${esc(e.domain)}">Remove</button>
        </td>
      </tr>`,
    )
    .join("");
  el("allowTable").querySelector("tbody").innerHTML = rows || `<tr><td class="muted">empty</td></tr>`;
}

el("addBtn").onclick = async () => {
  const domain = el("addDomain").value.trim();
  if (!domain) return;
  await api("/api/allowlist", { method: "POST", body: JSON.stringify({ domain }) });
  el("addDomain").value = "";
  refreshAllowlist();
  refreshAudit();
};

document.addEventListener("click", async (ev) => {
  const t = ev.target;
  if (t.dataset.challenge) {
    // Show the code on the page (no pop-up), then check for it automatically.
    const domain = t.dataset.challenge;
    const { ok, body } = await api(`/api/allowlist/${domain}/challenge`, { method: "POST", body: "{}" });
    if (!ok) {
      el("proofMsg").textContent = "Could not create a code: " + (body.reason || body.error || "error");
      return;
    }
    el("proofMsg").innerHTML = `
      <strong>${esc(domain)}</strong> — your code:
      <code id="proofToken">${esc(body.token)}</code>
      <button class="ghost" id="copyToken">Copy</button><br>
      Put it in a file at <code>https://${esc(domain)}/.well-known/secval-challenge.txt</code>
      (or a DNS TXT record at <code>_secval-challenge.${esc(domain)}</code>).
      secval checks for it by itself and scans the site as soon as it finds it.
      <div id="proofStatus"></div>`;
    el("copyToken").onclick = () => {
      navigator.clipboard?.writeText(body.token);
      el("copyToken").textContent = "Copied";
    };
    setPending(domain, true);
    watchProof(domain);
  } else if (t.dataset.scan) {
    el("scanUrl").value = t.dataset.scan;
    runScan(t.dataset.scan);
  } else if (t.dataset.remove) {
    // Two clicks instead of a pop-up: the first arms the button.
    if (t.dataset.armed !== "1") {
      t.dataset.armed = "1";
      t.textContent = "Click again to remove";
      return;
    }
    await api(`/api/allowlist/${t.dataset.remove}`, { method: "DELETE" });
    refreshAllowlist();
    refreshAudit();
  }
});

el("scanBtn").onclick = () => runScan(el("scanUrl").value.trim());

async function runScan(target) {
  if (!target) return;
  el("scanBtn").disabled = true;
  el("scanMsg").textContent = "Scanning " + target + "…";
  el("findings").innerHTML = "";
  try {
    const { ok, status, body } = await api("/api/scan", { method: "POST", body: JSON.stringify({ target }) });
    if (status === 401) {
      el("scanMsg").textContent = NEED_TOKEN;
    } else if (status === 403) {
      el("scanMsg").textContent = "Blocked by policy: " + body.reason;
    } else if (!ok) {
      el("scanMsg").textContent = "Scan could not complete: " + (body.reason || status);
    } else {
      el("scanMsg").textContent = `Scan of ${target} complete — ${body.findings.length} finding(s).`;
      el("findings").innerHTML = renderFindings(body.findings);
    }
  } finally {
    el("scanBtn").disabled = false;
    refreshAllowlist(); // keep the proven/unproven badges current
    refreshScans();
    refreshAudit();
  }
}

// --- Automatic proof checking ------------------------------------------------
// After "Get code", the page keeps checking (file first, then DNS) until the
// code is found, then scans. Domains waiting for proof are remembered in this
// browser so checking resumes when the page is reopened. Verification itself
// is done by the server's normal verify endpoint.
const CHECK_EVERY_MS = 20_000;
const CHECK_TIMES = 90; // about 30 minutes per visit
const watching = new Set();

function pendingDomains() {
  try { return JSON.parse(localStorage.getItem("secval_pending") || "[]"); } catch { return []; }
}
function setPending(domain, on) {
  const set = new Set(pendingDomains());
  on ? set.add(domain) : set.delete(domain);
  try { localStorage.setItem("secval_pending", JSON.stringify([...set])); } catch { /* not remembered */ }
}

async function verifyOnce(domain) {
  let first = null;
  for (const method of ["token-file", "dns-txt"]) {
    const { body } = await api(`/api/allowlist/${domain}/verify`, {
      method: "POST",
      body: JSON.stringify({ method }),
    });
    if (body.verified) return { verified: true };
    first ??= body;
  }
  return first ?? { verified: false };
}

async function watchProof(domain) {
  if (watching.has(domain)) return;
  watching.add(domain);
  const say = (text) => {
    const box = el("proofStatus") || el("proofMsg");
    box.textContent = text;
  };
  try {
    for (let i = 0; i < CHECK_TIMES; i++) {
      say("Looking for the code on " + domain + "…");
      const r = await verifyOnce(domain);
      if (r.verified) {
        setPending(domain, false);
        el("proofMsg").textContent = domain + " is verified. Scanning it now.";
        refreshAllowlist();
        await runScan(domain);
        return;
      }
      if (/no challenge issued|not on the allowlist/.test(r.reason || "")) {
        setPending(domain, false);
        say(domain + ": press Get code first.");
        return;
      }
      say("Not found on " + domain + " yet. Checking again shortly.");
      await new Promise((ok) => setTimeout(ok, CHECK_EVERY_MS));
    }
    say("Stopped checking " + domain + " for now. It resumes next time you open this page.");
  } finally {
    watching.delete(domain);
  }
}

function renderFindings(findings) {
  if (!findings.length) return `<p class="note">No passive weaknesses found.</p>`;
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return `<table><tbody>${findings
    .map(
      (f) => `
      <tr><td><span class="sev ${f.severity}">${f.severity}</span></td>
      <td><strong>${esc(f.title)}</strong><br><span class="muted">${esc(f.detail)}</span></td></tr>`,
    )
    .join("")}</tbody></table>`;
}

async function refreshScans() {
  const { ok, body } = await api("/api/scans");
  if (!ok) return;
  el("scansTable").querySelector("tbody").innerHTML = body.length
    ? body
        .map(
          (s) => `
      <tr><td><code>${esc(s.target)}</code></td><td>${esc(s.status)}</td>
      <td>${s.findingsCount} finding(s)</td><td class="muted">${esc(s.startedAt.replace("T", " ").slice(0, 19))}</td></tr>`,
        )
        .join("")
    : `<tr><td class="muted">no scans yet</td></tr>`;
}

async function refreshAudit() {
  const { ok, body } = await api("/api/audit?limit=20");
  if (!ok) return;
  el("auditTable").querySelector("tbody").innerHTML = body
    .map(
      (a) => `
      <tr><td class="muted">${esc(a.ts.replace("T", " ").slice(0, 19))}</td>
      <td>${esc(a.action)}</td><td>${esc(a.target || "")}</td>
      <td><span class="sev ${a.decision === "deny" ? "high" : "info"}">${esc(a.decision)}</span></td></tr>`,
    )
    .join("");
}

async function refreshSchedule() {
  const { ok, body } = await api("/api/schedule");
  if (!ok) return;
  el("scheduleText").textContent =
    body.description + (body.lastRun ? ` · last run ${body.lastRun}` : " · not run yet");
}
el("runNowBtn").onclick = async () => {
  el("runNowBtn").disabled = true;
  el("scheduleMsg").textContent = "Scanning all proven sites…";
  const { ok, status, body } = await api("/api/schedule/run-now", { method: "POST", body: "{}" });
  el("runNowBtn").disabled = false;
  if (!ok) {
    el("scheduleMsg").textContent = status === 401 ? NEED_TOKEN : "Could not run: " + (body.error || status);
    return;
  }
  el("scheduleMsg").textContent = `Done — scanned ${body.scanned} site(s), ${body.skipped} skipped (ownership not proven), ${body.totalFindings} finding(s).`;
  el("runNowBtn").disabled = false;
  refreshScans();
  refreshAudit();
};

function refreshAll() {
  refreshAllowlist();
  refreshScans();
  refreshAudit();
  refreshSchedule();
  refreshDashboard();
  if (currentTab === "tests") refreshTests();
}

el("tokenSave").onclick = async () => {
  const v = el("tokenInput").value.trim();
  if (!v) return;
  el("tokenSave").disabled = true;
  const status = await signIn(v);
  el("tokenSave").disabled = false;
  if (status === 429) return askForToken("Too many wrong tries. Wait a minute, then paste it again.");
  if (status !== 200) return askForToken(WRONG);
  el("tokenInput").value = "";
  el("tokenMsg").textContent = "";
  el("tokenBox").hidden = true;
  // Clear any "needs your token" messages left from before.
  for (const id of ["scanMsg", "scheduleMsg"]) el(id).textContent = "";
  // The data is private, so load it now that the page is signed in.
  refreshAll();
};

el("signOut").onclick = async () => {
  await api("/api/session/end", { method: "POST", body: "{}" });
  location.reload();
};

refreshKillSwitch();
// Runs after the rest of this script, so everything below is defined.
(async () => {
  await migrateOldToken();
  for (const d of pendingDomains()) watchProof(d);
  refreshAll();
})();

// --- Health dashboard --------------------------------------------------------
// One table row per app, one column per criterion. A cell shows the measured
// score (secval checked it) when there is one, else the latest pasted
// estimate. Clicking an app or a cell opens its evidence and infrastructure.
const tone = (n) => (n >= 85 ? "good" : n >= 65 ? "mid" : "bad");
const day = (iso) => esc(String(iso || "").slice(0, 10));

function scoreHtml(s, main) {
  const ev = `<details><summary>why</summary><ul>${s.evidence
    .map((e) => `<li>${esc(e)}</li>`)
    .join("")}<li>${day(s.at)}</li></ul></details>`;
  return main
    ? `<div class="num ${tone(s.score)}">${s.score}<span class="tag ${s.source}">${s.source}</span></div>${ev}`
    : `<div class="alt">${s.score} <span class="tag ${s.source}">${s.source}</span></div>${ev}`;
}

// The Database criterion's checklist (same as reports/database-checklist.md).
const DB_RULES = `<details class="note"><summary>How the Database score is worked out</summary>
<p>Ten rules, 10 points each (10 = done, 5 = partly, 0 = missing).</p><ol>${[
  "One master database: all business data in one place, copies are only copies.",
  "No duplicated data: each fact stored once.",
  "Links between records: foreign keys the database enforces.",
  "Unique IDs and rules: primary keys, unique and not-null rules.",
  "Versioned schema changes: tracked migrations, never by hand.",
  "Backups and proven restores: automatic, off-server, restore tested.",
  "Indexes on main lookups.",
  "Sensitive data protected: passwords hashed, personal data minimal or masked.",
  "No secrets in code: database passwords come from settings.",
  "Clear naming and a documented schema.",
].map((r) => `<li>${r}</li>`).join("")}</ol></details>`;

function renderApp(a) {
  const empty = !a.areas.some((ar) => ar.measured || ar.estimate);
  const areas = empty
    ? '<div class="note">No evidence yet. Prove ownership for measured checks, or paste a report.</div>'
    : a.areas
    .map((ar) => {
      const main = ar.measured || ar.estimate;
      const second = ar.measured && ar.estimate ? scoreHtml(ar.estimate, false) : "";
      return `<div class="area"><div class="name">${esc(ar.label)}</div>${
        main ? scoreHtml(main, true) + second : '<div class="alt">no evidence yet</div>'
      }</div>`;
    })
    .join("");
  const grid = empty ? areas : `<div class="areas">${areas}</div>`;
  const infra = `<table class="infra"><tbody>${a.infra
    .map(
      (f) => `<tr><td class="muted">${esc(f.label)}</td><td>${
        f.value
          ? `${esc(f.value)} <span class="tag ${f.source}">${f.source}</span>`
          : '<span class="muted">not known yet</span>'
      }<div class="note" style="margin:0">${esc(f.note)}${f.at ? " " + day(f.at) : ""}</div></td></tr>`,
    )
    .join("")}</tbody></table>`;
  const other = a.other.length
    ? `<div class="note">Also in the last report: ${a.other
        .map((o) => `${esc(o.label)} ${o.score}`)
        .join(", ")}</div>`
    : "";
  return `<div class="app">
    <div class="apphead">
      <code>${esc(a.host)}</code>
      ${a.overall !== null ? `<span class="overall ${tone(a.overall)}">${a.overall}</span><span class="muted">overall</span>` : ""}
      ${a.proven ? "" : '<span class="badge">unproven: no measured checks</span>'}
      <span class="muted">${a.reports} report(s) pasted</span>
    </div>
    ${grid}${other}${DB_RULES}
    <h3 class="sub3">Infrastructure</h3>${infra}
  </div>`;
}

// Short column names; the full criterion name is the column's tooltip.
const SHORT = {
  security: "Security", privacy: "Privacy", integrity: "Integrity", persistence: "Backup & recovery",
  database: "Database", ux: "UX", performance: "Speed", reliability: "Reliability",
  code: "Code", deploy: "Deploy & ops",
};
let dashData = [];
let openHost = null;

function cellHtml(a, ar) {
  const s = ar.measured || ar.estimate;
  if (!s) return `<td class="cell none" title="${esc(ar.label)}: no evidence yet">–</td>`;
  const mark = s.source === "measured" ? "M" : "E";
  const tip = `${ar.label}: ${s.score}% (${s.source}, ${String(s.at || "").slice(0, 10)})\n${s.evidence.join("\n")}`;
  return `<td class="cell ${tone(s.score)} ${s.source}" title="${esc(tip)}" data-open="${esc(a.host)}">${s.score}%<sup>${mark}</sup></td>`;
}

function renderTable(apps) {
  if (!apps.length) return "No apps on the allowlist yet.";
  const head = apps[0].areas
    .map((ar) => `<th title="${esc(ar.label)}">${esc(SHORT[ar.key] || ar.label)}</th>`)
    .join("");
  const rows = apps
    .map(
      (a) => `<tr>
        <th class="appname"><button class="link" data-open="${esc(a.host)}">${esc(a.host)}</button></th>
        ${a.overall === null ? '<td class="cell none">–</td>' : `<td class="cell ${tone(a.overall)} overallc">${a.overall}%</td>`}
        ${a.areas.map((ar) => cellHtml(a, ar)).join("")}
      </tr>`,
    )
    .join("");
  return `<div class="tablewrap"><table class="dash"><thead><tr><th class="appname">App</th><th>Overall</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderDetail() {
  const a = dashData.find((x) => x.host === openHost);
  el("dashDetail").innerHTML = a
    ? `<div class="row" style="align-items:center"><strong style="flex:1">Details: ${esc(a.host)}</strong><button class="ghost" id="closeDetail">Close</button></div>${renderApp(a)}`
    : "";
  if (a) el("closeDetail").onclick = () => { openHost = null; renderDetail(); };
}

document.addEventListener("click", (ev) => {
  const host = ev.target.closest?.("[data-open]")?.dataset.open;
  if (!host) return;
  openHost = openHost === host ? null : host;
  renderDetail();
  if (openHost) el("dashDetail").scrollIntoView({ behavior: "smooth", block: "start" });
});

async function refreshDashboard() {
  const { ok, body } = await api("/api/dashboard");
  if (!ok) return;
  dashData = body;
  el("dash").innerHTML = renderTable(body);
  el("dash").className = "";
  renderDetail();
  const sel = el("reportApp");
  const current = sel.value;
  sel.innerHTML = body.map((a) => `<option value="${esc(a.host)}">${esc(a.host)}</option>`).join("");
  if (current) sel.value = current;
}

el("checkNowBtn").onclick = async () => {
  el("checkNowBtn").disabled = true;
  el("dashMsg").textContent = "Checking all proven apps…";
  const { ok, body } = await api("/api/dashboard/check-now", { method: "POST", body: "{}" });
  el("dashMsg").textContent = ok ? `Checked ${body.checked} app(s).` : "Could not check: " + (body.error || "error");
  el("checkNowBtn").disabled = false;
  refreshDashboard();
};

let guessTimer;
el("reportText").addEventListener("input", () => {
  clearTimeout(guessTimer);
  guessTimer = setTimeout(async () => {
    const text = el("reportText").value;
    if (!text.trim() || !signedIn) return;
    const { ok, body } = await api("/api/dashboard/guess", { method: "POST", body: JSON.stringify({ text }) });
    if (ok && body.host) el("reportApp").value = body.host;
  }, 400);
});

el("reportBtn").onclick = async () => {
  const text = el("reportText").value;
  if (!text.trim()) return;
  const { ok, body } = await api("/api/dashboard/report", {
    method: "POST",
    body: JSON.stringify({ app: el("reportApp").value, text }),
  });
  if (!ok) {
    el("reportMsg").textContent = "Not saved: " + (body.error || "error");
    return;
  }
  const facts = body.infra.length ? ` and ${body.infra.length} infrastructure fact(s)` : "";
  el("reportMsg").textContent = `Saved ${body.scores.length} score(s)${facts} for ${body.host}${
    body.scores.length ? ": " + body.scores.map((s) => `${s.label} ${s.score}`).join(", ") : ""
  }.`;
  el("reportText").value = "";
  refreshDashboard();
  refreshAudit();
};

setInterval(refreshDashboard, 60 * 60_000); // hourly; scans, checks and saved reports refresh it at once

// --- Menus (tabs) -------------------------------------------------------------
// Each menu is a section of this one page. The address (#health, #scans,
// #tests, #settings) picks the menu, so links and reloads keep it; the last one
// used is remembered in this browser. The token box sits above the menus, so it
// shows whichever menu is open.
const TABS = ["health", "scans", "tests", "settings"];
let currentTab = "health";
function showTab(name) {
  const tab = TABS.includes(name) ? name : "health";
  currentTab = tab;
  for (const sec of document.querySelectorAll("[data-panel]")) sec.hidden = sec.dataset.panel !== tab;
  for (const a of document.querySelectorAll("nav.tabs a")) a.setAttribute("aria-selected", String(a.dataset.tab === tab));
  try { localStorage.setItem("secval_tab", tab); } catch { /* not remembered */ }
  if (tab === "tests" && signedIn) refreshTests();
}
function storedTab() {
  try { return localStorage.getItem("secval_tab"); } catch { return null; }
}
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// --- All tests ---------------------------------------------------------------
// Every check secval runs on the chosen app, with a green tick for pass, a red
// cross for fail (and what to do about it), and grey for checks not run yet.
let testsData = null;
let testsFilter = "all";

async function loadTestApps() {
  const { ok, body } = await api("/api/tests");
  if (!ok) return;
  const sel = el("testsApp");
  const keep = sel.value || storedTestsApp();
  sel.innerHTML = body.map((h) => `<option>${esc(h)}</option>`).join("");
  if (keep && body.includes(keep)) sel.value = keep;
}
function storedTestsApp() {
  try { return localStorage.getItem("secval_tests_app"); } catch { return null; }
}

async function refreshTests() {
  if (!el("testsApp").options.length) await loadTestApps();
  const host = el("testsApp").value;
  if (!host) {
    el("testsList").textContent = signedIn ? "No apps yet. Add one in Security scans." : NEED_TOKEN;
    return;
  }
  const { ok, status, body } = await api("/api/tests/" + encodeURIComponent(host));
  if (!ok) {
    el("testsList").textContent = status === 401 ? NEED_TOKEN : "Could not load tests: " + (body.error || "error");
    return;
  }
  testsData = body;
  renderTests();
}

function renderTests() {
  const d = testsData;
  if (!d) return;
  const when = d.lastScan ? `Last scan ${day(d.lastScan.finishedAt)} (${esc(d.lastScan.mode)})` : "Not scanned yet";
  const rep = d.reportDate ? ` · health report ${day(d.reportDate)}` : "";
  el("testsSummary").innerHTML =
    `<span class="p"><b>${d.passed}</b>passed</span><span class="f"><b>${d.failed}</b>failed</span>` +
    `<span class="n"><b>${d.notRun}</b>not run</span><span class="muted" style="align-self:center">of ${d.total} tests · ${when}${rep}</span>`;
  const rows = d.checks.filter((c) => testsFilter === "all" || c.status === testsFilter);
  // Failed first within each group, worst severity first.
  const sevRank = { high: 0, medium: 1, low: 2, info: 3 };
  const stRank = { fail: 0, pass: 1, "not-run": 2 };
  const groups = [];
  for (const c of rows) {
    let g = groups.find((x) => x.label === c.groupLabel);
    if (!g) groups.push((g = { label: c.groupLabel, items: [] }));
    g.items.push(c);
  }
  const icon = { pass: "✓", fail: "✕", "not-run": "–" };
  el("testsList").innerHTML = groups.length
    ? groups
        .map((g) => {
          const items = g.items
            .sort((a, b) => stRank[a.status] - stRank[b.status] || sevRank[a.severity] - sevRank[b.severity])
            .map(
              (c) => `<div class="trow">
                <span class="ticon ${c.status}" aria-label="${c.status}">${icon[c.status]}</span>
                <div class="tbody">
                  <div class="tt">${esc(c.title)}${c.status === "fail" && c.group !== "health" ? ` <span class="sev ${c.severity}">${c.severity}</span>` : ""}</div>
                  ${c.advice ? `<div class="tadv ${c.status}">${c.status === "fail" ? "<strong>Fix:</strong> " : ""}${esc(c.advice)}</div>` : ""}
                  ${c.detail ? `<details><summary>details</summary><div class="tdet">${esc(c.detail)}</div></details>` : ""}
                </div>
              </div>`,
            )
            .join("");
          const fails = g.items.filter((c) => c.status === "fail").length;
          return `<h3 class="tgroup">${esc(g.label)} (${g.items.length}${fails ? `, ${fails} failed` : ""})</h3>${items}`;
        })
        .join("")
    : `<div class="muted">Nothing to show here.</div>`;
}

el("testsApp").onchange = () => {
  try { localStorage.setItem("secval_tests_app", el("testsApp").value); } catch { /* not remembered */ }
  refreshTests();
};
for (const b of document.querySelectorAll("[data-tfilter]")) {
  b.onclick = () => {
    testsFilter = b.dataset.tfilter;
    for (const x of document.querySelectorAll("[data-tfilter]")) x.setAttribute("aria-pressed", String(x === b));
    renderTests();
  };
}
// Runs the fullest scan the safety rules allow: an active scan when the app is
// cleared for it, otherwise a passive scan. The policy engine decides either way.
el("testsRunBtn").onclick = async () => {
  const target = el("testsApp").value;
  if (!target) return;
  el("testsRunBtn").disabled = true;
  el("testsMsg").textContent = "Running all tests on " + target + "…";
  try {
    let r = await api("/api/scan/active", { method: "POST", body: JSON.stringify({ target }) });
    let kind = "full";
    if (r.status === 403) {
      r = await api("/api/scan", { method: "POST", body: JSON.stringify({ target }) });
      kind = "basic";
    }
    if (r.status === 401) el("testsMsg").textContent = NEED_TOKEN;
    else if (r.status === 403) el("testsMsg").textContent = "Blocked by the safety rules: " + r.body.reason;
    else if (!r.ok) el("testsMsg").textContent = "Scan could not finish: " + (r.body.reason || r.body.error || r.status);
    else
      el("testsMsg").textContent =
        kind === "full"
          ? "Done: full scan finished."
          : "Done: basic scan finished. The other checks need the app cleared for active scans.";
  } finally {
    el("testsRunBtn").disabled = false;
    refreshTests();
    refreshScans();
    refreshDashboard();
    refreshAudit();
  }
};

showTab(location.hash.slice(1) || storedTab() || "health");

