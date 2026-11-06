import type { DatasetSpec } from "../types.js";
import { COMPPLAN_SPECS } from "./compplan.js";
import { LMOP_SPECS } from "./lm-op-model.js";
import { NEXUS_SPECS } from "./nexus.js";
import { TENBONDS_SPECS } from "./tenbonds.js";

/**
 * Registry of per-dataset rules. One file per app under this folder, each
 * exporting a list of DatasetSpec. The rules ARE the documentation: every
 * threshold lives in the spec (and the weights/bands in policy.ts), nothing is
 * decided by judgment at run time. A dataset with no spec is scored UNVERIFIED.
 */
const SPECS = new Map<string, DatasetSpec>();

registerSpecsEarly();

function registerSpecsEarly(): void {
  for (const s of [...COMPPLAN_SPECS, ...LMOP_SPECS, ...NEXUS_SPECS, ...TENBONDS_SPECS]) SPECS.set(s.id, s);
}

export function registerSpecs(specs: DatasetSpec[]): void {
  for (const s of specs) SPECS.set(s.id, s);
}

export function getSpec(id: string): DatasetSpec | undefined {
  return SPECS.get(id);
}

export function listSpecs(): DatasetSpec[] {
  return [...SPECS.values()].sort((a, b) => a.id.localeCompare(b.id));
}
