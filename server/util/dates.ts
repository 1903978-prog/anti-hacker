// Server-side twin of public/dates.js. Display format: "03 Nov 2026" / "03 Nov 2026, 14:05 UTC".
// Display only: stored data and API values stay ISO.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
}

export function formatDateTimeUtc(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? `${formatDate(d)}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC` : "";
}
