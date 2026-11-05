import type { AppKey, Catalog, FkCandidate } from "./types.js";
import { CLASSIFIED, PRIORITY_TABLES } from "./registry.js";

function stemCandidates(stem: string): string[] {
  const out = [stem, `${stem}s`, `${stem}es`];
  if (stem.endsWith("y")) out.push(`${stem.slice(0, -1)}ies`);
  return out;
}
const family = (t: string): string => {
  const x = t.toLowerCase();
  if (/int|serial|numeric|bigint|smallint/.test(x)) return "int";
  if (x === "uuid") return "uuid";
  if (/char|text/.test(x)) return "text";
  return x;
};

/** Every `_id` column that is not already the source of a declared foreign key. */
export function buildInventory(app: AppKey, cat: Catalog): FkCandidate[] {
  const declared = new Set(cat.foreignKeys.flatMap((f) => f.columns.map((c) => `${f.table}.${c}`)));
  const tableNames = new Set(cat.tables.map((t) => t.name));
  const pkByTable = new Map<string, string>();
  for (const i of cat.indexes) if (i.primary && i.columns.length === 1) pkByTable.set(i.table, i.columns[0]!);
  const typeOf = new Map(cat.columns.map((c) => [`${c.table}.${c.name}`, c.type]));
  const uniqueCols = new Set(cat.indexes.filter((i) => i.unique && i.columns.length === 1).map((i) => `${i.table}.${i.columns[0]}`));
  const reg = new Map(CLASSIFIED[app].map((c) => [c.column, c]));
  const prio = PRIORITY_TABLES[app];
  const out: FkCandidate[] = [];

  for (const col of cat.columns) {
    if (!/_id$/i.test(col.name)) continue;
    const key = `${col.table}.${col.name}`;
    if (declared.has(key)) continue;
    if (pkByTable.get(col.table) === col.name && col.name.toLowerCase() === "id") continue;

    const known = reg.get(key);
    let targetTable: string | null = null;
    let targetColumn: string | null = null;
    let ambiguous = false;
    let evidence = "Column name ends in _id. A name alone does not prove a relationship; classification needs code inspection.";

    if (known?.target) {
      const [t, c] = known.target.split(".");
      targetTable = t ?? null;
      targetColumn = c ?? null;
    } else {
      const stem = col.name.replace(/_id$/i, "").toLowerCase();
      const hits = stemCandidates(stem).filter((n) => tableNames.has(n) && n !== col.table);
      if (hits.length === 1) {
        targetTable = hits[0]!;
        targetColumn = pkByTable.get(targetTable) ?? null;
        if (!targetColumn) evidence += ` Target table ${targetTable} has no single-column primary key.`;
      } else if (hits.length > 1) {
        ambiguous = true;
        evidence += ` Several tables match (${hits.join(", ")}).`;
      } else {
        evidence += " No table matches the column name.";
      }
    }
    if (targetTable && targetColumn) {
      const a = family(col.type), b = family(typeOf.get(`${targetTable}.${targetColumn}`) ?? "?");
      if (a !== b) evidence += ` Type mismatch (${col.type} vs ${typeOf.get(`${targetTable}.${targetColumn}`)}): an FK would need a conversion.`;
    }
    out.push({
      sourceTable: col.table,
      sourceColumn: col.name,
      targetTable,
      targetColumn,
      targetAmbiguous: ambiguous,
      cardinality: !targetTable ? "unknown" : uniqueCols.has(key) ? "one-to-one" : "many-to-one",
      classification: known?.classification ?? "UNVERIFIED",
      evidence: known ? `${known.evidence} (registry)` : evidence,
      orphans: null,
      rowsExamined: null,
      criticality: prio.test(col.table) || (targetTable !== null && prio.test(targetTable)) ? "high" : "medium",
      recommendedAction: known
        ? known.classification === "mandatory" || known.classification === "optional"
          ? "Add a NOT VALID foreign key, then VALIDATE after orphan check passes (draft migration available)."
          : "No foreign key: documented as intentionally non-relational."
        : "Inspect application code to classify (mandatory / optional / external / intentionally non-FK).",
    });
  }
  return out.sort((a, b) => (a.criticality === b.criticality ? a.sourceTable.localeCompare(b.sourceTable) : a.criticality === "high" ? -1 : 1));
}

export { family };
