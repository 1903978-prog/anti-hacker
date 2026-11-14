/**
 * Writes the EEES file formats as JSON Schema (eees/v1.0/schema/*.json) so
 * apps not written in TypeScript can validate their evidence files.
 * Run: npm run eees:schema
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EEES_DIR, CURRENT_VERSION } from "../../server/eees/registry.js";
import { appsSchema, criteriaSchema, evidenceFileSchema, flowsSchema } from "../../server/eees/types.js";

const dir = join(EEES_DIR, CURRENT_VERSION, "schema");
mkdirSync(dir, { recursive: true });
for (const [name, schema] of [
  ["criteria", criteriaSchema],
  ["evidence", evidenceFileSchema],
  ["apps", appsSchema],
  ["flows", flowsSchema],
] as const) {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  writeFileSync(join(dir, `${name}.schema.json`), JSON.stringify(json, null, 2) + "\n");
}
console.log(`eees: wrote 4 JSON Schemas to ${dir}`);
