// secval control-plane UI. State-changing calls send a bearer token (the
// server's SECVAL_API_TOKEN); it is asked for once and kept in sessionStorage.
function getToken() {
  let t = sessionStorage.getItem("secval_token");
  if (!t) {
    t = window.prompt("Enter the secval API token (set on the server as SECVAL_API_TOKEN):") || "";
    if (t) sessionStorage.setItem("secval_token", t);
  }
  return t;
}
function clearToken() {
  sessionStorage.removeItem("secval_token");
}

const api = (path, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (method !== "GET" && method !== "HEAD") headers["authorization"] = "Bearer " + getToken();
  return fetch(path, { ...opts, headers }).then((r) =>
    r.json().then((b) => {
      if (r.status === 401) {
        clearToken();
        window.alert("The API token was missing or wrong. Please try again.");
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
              ? ""
              : `<button class="ghost" data-challenge="${esc(e.domain)}">Challenge</button>
          <button class="ghost" data-verify="${esc(e.domain)}">Verify</button>`
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
    const { body } = await api(`/api/allowlist/${t.dataset.challenge}/challenge`, { method: "POST", body: "{}" });
    window.prompt(
      "Place this token via a DNS TXT record at _secval-challenge." +
        t.dataset.challenge +
        "\nor at /.well-known/secval-challenge.txt, then click Verify.\n\nToken (copy):",
      body.token,
    );
  } else if (t.dataset.verify) {
    const method = window.confirm("OK = verify by DNS TXT record.\nCancel = verify by token file on the site.")
      ? "dns-txt"
      : "token-file";
    const { body } = await api(`/api/allowlist/${t.dataset.verify}/verify`, {
      method: "POST",
      body: JSON.stringify({ method }),
    });
    window.alert(body.verified ? "Ownership verified." : "Not verified: " + body.reason);
    refreshAllowlist();
    refreshAudit();
  } else if (t.dataset.remove) {
    if (window.confirm("Remove " + t.dataset.remove + "?")) {
      await api(`/api/allowlist/${t.dataset.remove}`, { method: "DELETE" });
      refreshAllowlist();
      refreshAudit();
    }
  }
});

el("scanBtn").onclick = async () => {
  const target = el("scanUrl").value.trim();
  if (!target) return;
  el("scanBtn").disabled = true;
  el("scanMsg").textContent = "Requesting approval and scanning…";
  el("findings").innerHTML = "";
  try {
    const { ok, status, body } = await api("/api/scan", { method: "POST", body: JSON.stringify({ target }) });
    if (status === 403) {
      el("scanMsg").textContent = "Blocked by policy: " + body.reason;
    } else if (!ok) {
      el("scanMsg").textContent = "Scan could not complete: " + (body.reason || status);
    } else {
      el("scanMsg").textContent = `Scan complete — ${body.findings.length} finding(s).`;
      el("findings").innerHTML = renderFindings(body.findings);
    }
  } finally {
    el("scanBtn").disabled = false;
    refreshScans();
    refreshAudit();
  }
};

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

refreshKillSwitch();
refreshAllowlist();
refreshScans();
refreshAudit();
refreshSchedule();
