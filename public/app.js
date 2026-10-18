// secval control-plane UI. State-changing calls send a bearer token (the
// server's SECVAL_API_TOKEN); it is asked for once and remembered in this
// browser (localStorage), so it is not asked again on every visit.
function readStored() {
  try { return localStorage.getItem("secval_token"); } catch { return null; }
}
// The token is typed into a small box on the page (no pop-up). The box only
// shows while no token is saved.
function getToken() {
  return readStored() || "";
}
function showTokenBox(message) {
  el("tokenBox").hidden = !!readStored();
  if (message) el("tokenMsg").textContent = message;
}
function clearToken() {
  try { localStorage.removeItem("secval_token"); } catch { /* nothing stored */ }
}

const api = (path, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (method !== "GET" && method !== "HEAD") headers["authorization"] = "Bearer " + getToken();
  return fetch(path, { ...opts, headers }).then((r) =>
    r.json().then((b) => {
      if (r.status === 401) {
        clearToken();
        showTokenBox("That secret token was missing or wrong. Paste it again.");
      }
      return { ok: r.ok, status: r.status, body: b };
    }),
  );
};
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
  const { body } = await api("/api/allowlist");
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
    if (status === 403) {
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
  const { body } = await api("/api/scans");
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
  const { body } = await api("/api/audit?limit=20");
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
  const { body } = await api("/api/schedule");
  el("scheduleText").textContent =
    body.description + (body.lastRun ? ` · last run ${body.lastRun}` : " · not run yet");
}
el("runNowBtn").onclick = async () => {
  el("runNowBtn").disabled = true;
  el("scheduleMsg").textContent = "Scanning all proven sites…";
  const { body } = await api("/api/schedule/run-now", { method: "POST", body: "{}" });
  el("scheduleMsg").textContent = `Done — scanned ${body.scanned} site(s), ${body.skipped} skipped (ownership not proven), ${body.totalFindings} finding(s).`;
  el("runNowBtn").disabled = false;
  refreshScans();
  refreshAudit();
};

el("tokenSave").onclick = () => {
  const v = el("tokenInput").value.trim();
  if (!v) return;
  try { localStorage.setItem("secval_token", v); } catch { /* not remembered */ }
  el("tokenInput").value = "";
  el("tokenMsg").textContent = "";
  showTokenBox();
};

showTokenBox();
for (const d of pendingDomains()) watchProof(d);
refreshKillSwitch();
refreshAllowlist();
refreshScans();
refreshAudit();
refreshSchedule();

// --- Health dashboard --------------------------------------------------------
// One block per app; each area shows its measured score (secval checked it)
// and/or its latest pasted estimate, with the evidence behind each number.
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
    ${grid}${other}
    <details><summary>Infrastructure</summary>${infra}</details>
  </div>`;
}

async function refreshDashboard() {
  const { ok, body } = await api("/api/dashboard");
  if (!ok) return;
  el("dash").innerHTML = body.map(renderApp).join("") || "No apps on the allowlist yet.";
  el("dash").className = "";
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
    if (!text.trim() || !getToken()) return;
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

refreshDashboard();
setInterval(refreshDashboard, 60_000);
