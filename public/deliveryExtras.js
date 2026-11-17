/* global formatDateTime, module */
// Delivery menu extras (16 Nov 2026, Livio):
//  - chart of open atoms over the last 72 hours for the selected app, from the
//    ledger file's commit history (/api/delivery/history; no invented points);
//  - "Copy table": every atom of the selected app as plain text;
//  - "Copy prompt": a ready-to-paste recap of what is pending, for a Claude Code session.
// Kept in its own file so the main page script is untouched. Read only.
(() => {
  const $ = (id) => document.getElementById(id);
  const escH = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const STAGES = [["implemented", "Implemented"], ["tested", "Tested"], ["merged", "Merged"], ["deployed", "Deployed"], ["live_checked", "Live checked"]];
  const ICON = { yes: "✅", no: "❌", parked: "⏸️", unknown: "❓" };
  const WORD = { yes: "done", no: "not done", parked: "parked", unknown: "unknown" };
  let shownRepo = null;
  let data = null;

  const selectedRepo = () => document.querySelector('#dlApps [aria-pressed="true"]')?.dataset.dlapp || null;

  async function getJson(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }

  // --- Chart ------------------------------------------------------------------
  function chartSvg(h) {
    const W = 420, H = 150, L = 34, R = 10, T = 10, B = 26;
    const t0 = Date.parse(h.from), t1 = Date.parse(h.to);
    const pts = h.points.map((p) => ({ t: Math.min(t1, Math.max(t0, Date.parse(p.at))), v: p.open, p }));
    const maxV = Math.max(1, ...pts.map((p) => p.v));
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - v / maxV) * (H - T - B);
    // Step line: the count holds until the next change; the last value is carried to "now".
    let d = "";
    pts.forEach((p, i) => {
      d += i === 0 ? `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}` : `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}`;
    });
    if (pts.length) d += `H${x(t1).toFixed(1)}`;
    const dots = pts
      .map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3"><title>${escH(formatDateTime(p.p.at))}: ${p.v} open of ${p.p.total} (commit ${escH(p.p.sha)})</title></circle>`)
      .join("");
    const ticks = [72, 48, 24, 0]
      .map((hAgo) => {
        const tx = x(t1 - hAgo * 3_600_000);
        return `<line x1="${tx}" x2="${tx}" y1="${T}" y2="${H - B}" class="grid"/><text x="${tx}" y="${H - 8}" text-anchor="middle">${hAgo ? `-${hAgo}h` : "now"}</text>`;
      })
      .join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Open atoms over the last 72 hours" class="dlchart-svg">
      ${ticks}
      <text x="${L - 4}" y="${y(maxV) + 4}" text-anchor="end">${maxV}</text>
      <text x="${L - 4}" y="${y(0) + 4}" text-anchor="end">0</text>
      <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="axis"/>
      ${d ? `<path d="${d}" class="line"/>` : ""}${dots}
    </svg>`;
  }

  async function renderChart() {
    const repo = selectedRepo();
    const box = $("dlChart");
    if (!box || !repo) return;
    box.innerHTML = `<div class="dlchart-title">Open atoms, last 72 hours</div><div class="note">Loading…</div>`;
    let h;
    try {
      h = await getJson("/api/delivery/history?repo=" + encodeURIComponent(repo));
    } catch {
      box.innerHTML = `<div class="dlchart-title">Open atoms, last 72 hours</div><div class="note">History could not be loaded.</div>`;
      return;
    }
    if (repo !== selectedRepo()) return; // the user picked another app meanwhile
    const last = h.points[h.points.length - 1];
    box.innerHTML =
      `<div class="dlchart-title">Open atoms, last 72 hours${last ? ` <b>${last.open}</b> now` : " <b>?</b> unknown"}${h.incomplete ? ' <span class="dlinc">incomplete history</span>' : ""}</div>` +
      (h.points.length ? chartSvg(h) : "") +
      `<div class="note">${escH(h.points.length ? h.note : h.note || "No history yet.")}</div>`;
  }

  // --- Copy table and prompt ------------------------------------------------------
  const cell = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  const asked = (a) => `${a.asked_at || "unknown"}${a.asked_time && a.asked_time !== "unknown" ? " " + a.asked_time : ""}`;

  // Progress (0-100%) comes from the server's progress rules; older payloads without it show "unknown".
  const pct = (a) => (typeof a.percent === "number" ? `${a.percent}%${a.stage_label ? ` ${a.stage_label}` : ""}` : "unknown");
  // "Tested" marked yes but not proven on the current head SHA does not count as done.
  const stageDone = (a, k) => a[k] === "yes" && !(k === "tested" && a.tested_stale);
  const stageWord = (a, k) => (k === "tested" && a.tested === "yes" && a.tested_stale ? "marked done, but not proven on the current head SHA" : WORD[a[k]] || "unknown");

  function tableText(app) {
    const head = ["Atom ID", "Asked", "Original ask", "This atom", "Progress", ...STAGES.map(([, l]) => l), "Next step"];
    const rows = app.atoms.map((a) => [a.id, asked(a), a.original_ask, a.atom, pct(a), ...STAGES.map(([k]) => ICON[a[k]] || "❓"), a.next_step].map(cell));
    return [
      `Delivery ledger: ${app.project} (${app.repo})${app.branch ? `, branch ${app.branch}` : ""}${app.lastSynced ? `, last synced ${app.lastSynced}` : ""}`,
      `Atoms: ${app.counts.total} · open ${app.counts.open} · ${STAGES.map(([k, l]) => `${l.toLowerCase()} ${app.counts[k]}`).join(" · ")} · done ${app.counts.done}`,
      "✅ done · ❌ not done · ⏸️ parked · ❓ unknown",
      "",
      `| ${head.join(" | ")} |`,
      `|${head.map(() => "---").join("|")}|`,
      ...rows.map((r) => `| ${r.join(" | ")} |`),
    ].join("\n");
  }

  function promptText(app) {
    const open = app.atoms.filter((a) => !a.done);
    const lines = open.map((a) => {
      const done = STAGES.filter(([k]) => stageDone(a, k)).map(([, l]) => l);
      const notDone = STAGES.filter(([k]) => !stageDone(a, k)).map(([k, l]) => `${l} (${stageWord(a, k)})`);
      return [
        `- ${cell(a.id)}: ${cell(a.atom)}`,
        `  Original ask: "${cell(a.original_ask)}"`,
        `  Progress: ${pct(a)}`,
        `  Done: ${done.length ? done.join(", ") : "nothing yet"}`,
        `  Not done: ${notDone.join(", ")}`,
        `  Next step (from the ledger): ${cell(a.next_step) || "not stated"}`,
        a.evidence ? `  Evidence on record: ${cell(a.evidence)}` : "",
      ].filter(Boolean).join("\n");
    });
    return [
      `Follow up and close the open atoms of ${app.project} (repository ${OWNER_REPO(app)}).`,
      `Source: docs/delivery-ledger.json${app.branch ? ` on branch ${app.branch}` : ""}${app.lastSynced ? `, last synced ${app.lastSynced}` : ""}, as shown on the Secval Delivery page.`,
      `Status: ${app.counts.total} atoms, ${open.length} open, ${app.counts.done} fully done.`,
      "",
      `Open atoms (${open.length}):`,
      ...(lines.length ? lines : ["- none"]),
      "",
      "How to work:",
      "1. Re-read the ledger file and the repository first; the list above may be out of date. Do not redo work that is already done.",
      "2. For each atom, go stage by stage in order: Implemented, Tested, Merged, Deployed, Live checked. Move an atom to the next stage only with evidence (commit SHA, test run, PR, version endpoint, live check) and record that evidence in the ledger row in the same turn.",
      "3. An atom is closed only when every stage is done and the live check passed this turn. Never write done, live or fixed without checking it.",
      "4. Never invent dates, SHAs, PR numbers, test results or approvals. Write unknown and the next step instead.",
      "5. Do NOT merge, deploy or change production data without Livio's explicit approval of the exact commit SHA. Prepare the release and ask for that approval instead.",
      "6. End with one line of counts by stage and the list of atoms still open, each with its next step and owner.",
    ].join("\n");
  }
  const OWNER_REPO = (app) => `1903978-prog/${app.repo}`;

  async function copy(text, msgEl, what) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    msgEl.textContent = ok ? `Copied ${what}. Paste it into a Claude Code session.` : "Your browser blocked copying.";
    setTimeout(() => { msgEl.textContent = ""; }, 5000);
  }

  async function withApp(fn) {
    const msg = $("dlCopyMsg");
    // The app is fixed when the button is pressed, so switching apps during the fetch cannot copy another app.
    const repo = selectedRepo();
    try {
      data = await getJson("/api/delivery"); // server-side cache: no extra GitHub calls
    } catch {
      msg.textContent = "Could not load the ledger.";
      return;
    }
    const app = (data?.apps || []).find((a) => a.repo === repo);
    if (!app || app.status !== "ok") {
      msg.textContent = "This app has no ledger file to copy yet.";
      return;
    }
    await fn(app, msg);
  }

  function wire() {
    const apps = $("dlApps");
    if (!apps || !$("dlChart")) return;
    $("dlCopyTable").onclick = () => withApp((app, msg) => copy(tableText(app), msg, `the ${app.project} table (${app.atoms.length} atoms)`));
    $("dlCopyPrompt").onclick = () => withApp((app, msg) => copy(promptText(app), msg, `the Claude Code prompt for ${app.project} (${app.atoms.filter((a) => !a.done).length} open atoms)`));
    // Redraw the chart whenever another app is selected (or the list is first drawn).
    new MutationObserver(() => {
      const repo = selectedRepo();
      if (repo && repo !== shownRepo) {
        shownRepo = repo;
        renderChart();
      }
    }).observe(apps, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed"] });
    // Same 10-minute pace as the table.
    setInterval(() => { if (!document.hidden && shownRepo && !$("dlChart").closest("[hidden]")) renderChart(); }, 10 * 60_000);
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
  }
  if (typeof module !== "undefined") module.exports = { tableText, promptText };
})();
