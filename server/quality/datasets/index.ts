import type { DatasetSpec } from "../types.js";

/**
 * Registry of per-dataset rules. One file per app under this folder, each
 * exporting a list of DatasetSpec. The rules ARE the documentation: every
 * threshold lives in the spec (and the weights/bands in policy.ts), nothing is
 * decided by judgment at run time. A dataset with no spec is scored UNVERIFIED.
 */
const SPECS = new Map<string, DatasetSpec>();

export function registerSpecs(specs: DatasetSpec[]): void {
  for (const s of specs) SPECS.set(s.id, s);
}

export function getSpec(id: string): DatasetSpec | undefined {
  return SPECS.get(id);
}

export function listSpecs(): DatasetSpec[] {
  return [...SPECS.values()].sort((a, b) => a.id.localeCompare(b.id));
}
