/* global module */
// One place for every date shown to people. Format: "03 Nov 2026" (and "03 Nov 2026, 14:05").
// Display only: stored data and API values stay ISO.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");
function parts(value, timeZone) {
  const d = value instanceof Date ? value : new Date(value);
  if (value == null || value === "" || Number.isNaN(d.getTime())) return null;
  if (!timeZone && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) timeZone = "UTC"; // date-only: no shift
  if (!timeZone) return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute };
}
function formatDate(value, timeZone) {
  const p = parts(value, timeZone);
  return p ? `${pad2(p.d)} ${MONTHS[p.m]} ${p.y}` : "";
}
function formatDateTime(value, timeZone) {
  const p = parts(value, timeZone);
  return p ? `${pad2(p.d)} ${MONTHS[p.m]} ${p.y}, ${pad2(p.h)}:${pad2(p.mi)}` : "";
}
if (typeof module !== "undefined") module.exports = { formatDate, formatDateTime };
