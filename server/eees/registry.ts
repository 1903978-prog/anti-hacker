/**
 * Loads the EEES files from the repository folder eees/ and checks them.
 * Read-only. A missing or invalid file is reported as a problem, never turned
 * into a score: an app whose evidence file is broken is shown as UNKNOWN.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "../db.js";
import { liveResults } from "./live.js";
import { portfolioIndex, scoreApp, type AppScore, type Portfolio } from "./engine.js";
import {
  appsSchema,
  criteriaSchema,
  evidenceFileSchema,
  flowsSchema,
  type AppsFile,
  type Criteria,
  type EvidenceFile,
  type FlowsFile,
} from "./types.js";

export const EEES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eees");
export const CURRENT_VERSION = "v1.0";

export interface Registry {
  dir: string;
  criteria: Criteria;
  apps: AppsFile;
  flows: FlowsFile | null;
  evidence: Map<string, EvidenceFile>;
  problems: string[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Integrity rules of the standard itself (weights, ids, domains). */
export function checkCriteria(c: Criteria): string[] {
  const problems: string[] = [];
  if (c.dimensions.length !== 30) problems.push(`expected 30 dimensions, found ${c.dimensions.length}`);
  const total = c.dimensions.reduce((s, d) => s + d.weight, 0);
  if (Math.abs(total - 100) > 1e-9) problems.push(`dimension weights add up to ${total}, not 100`);
  for (const dom of c.domains) {
    const sum = c.dimensions.filter((d) => d.domain === dom.id).reduce((s, d) => s + d.weight, 0);
    if (Math.abs(sum - dom.weight) > 1e-9) problems.push(`domain ${dom.id}: dimensions add up to ${sum}, domain weight is ${dom.weight}`);
  }
  const ids = new Set<string>();
  for (const d of c.dimensions) {
    if (d.id !== `D${String(d.n).padStart(2, "0")}`) problems.push(`${d.id}: id does not match number ${d.n}`);
    if (!c.domains.some((x) => x.id === d.domain)) problems.push(`${d.id}: unknown domain ${d.domain}`);
    for (const ch of d.checks) {
      if (!ch.id.startsWith(`${d.id}.`)) problems.push(`${ch.id}: not inside ${d.id}`);
      if (ids.has(ch.id)) problems.push(`${ch.id}: duplicate check id`);
      ids.add(ch.id);
    }
  }
  return problems;
}

export function loadRegistry(dir: string = EEES_DIR): Registry {
  const problems: string[] = [];
  const criteria = criteriaSchema.parse(readJson(join(dir, CURRENT_VERSION, "criteria.json")));
  problems.push(...checkCriteria(criteria));
  const apps = appsSchema.parse(readJson(join(dir, "apps.json")));

  let flows: FlowsFile | null = null;
  const flowsPath = join(dir, "flows.json");
  if (existsSync(flowsPath)) {
    const parsed = flowsSchema.safeParse(readJson(flowsPath));
    if (parsed.success) flows = parsed.data;
    else problems.push(`flows.json is invalid: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
  } else problems.push("flows.json is missing: cross-application checks stay UNKNOWN");

  const checkIds = new Set(criteria.dimensions.flatMap((d) => d.checks.map((c) => c.id)));
  const evidence = new Map<string, EvidenceFile>();
  for (const app of apps.apps) {
    const path = join(dir, app.evidence);
    if (!existsSync(path)) {
      problems.push(`${app.id}: evidence file ${app.evidence} missing: everything UNKNOWN`);
      continue;
    }
    let raw: unknown;
    try {
      raw = readJson(path);
    } catch {
      problems.push(`${app.id}: ${app.evidence} is not valid JSON: everything UNKNOWN`);
      continue;
    }
    const parsed = evidenceFileSchema.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      problems.push(`${app.id}: ${app.evidence} is invalid (${i?.path.join(".")}: ${i?.message}): everything UNKNOWN`);
      continue;
    }
    const ev = parsed.data;
    if (ev.app !== app.id) problems.push(`${app.id}: evidence file names app "${ev.app}"`);
    if (ev.standardVersion !== criteria.version) problems.push(`${app.id}: evidence is for EEES ${ev.standardVersion}, standard is ${criteria.version}`);
    for (const id of Object.keys(ev.checks)) if (!checkIds.has(id)) problems.push(`${app.id}: unknown check ${id} ignored`);
    evidence.set(app.id, ev);
  }
  return { dir, criteria, apps, flows, evidence, problems };
}

export interface EeesView {
  standard: { name: string; version: string; title: string; adopted: string; approvedBy: string };
  computedAt: string;
  portfolio: Portfolio;
  apps: AppScore[];
  problems: string[];
  criteria: Criteria;
}

/** The whole dashboard: every app scored, plus the ESII portfolio index. */
export function eeesView(db: DB | null, dir: string = EEES_DIR, now: Date = new Date()): EeesView {
  const reg = loadRegistry(dir);
  const apps = reg.apps.apps.map((app) =>
    scoreApp(reg.criteria, app, reg.evidence.get(app.id) ?? null, reg.flows, db ? liveResults(db, app.hosts, now) : {}, now),
  );
  return {
    standard: {
      name: reg.criteria.standard,
      version: reg.criteria.version,
      title: reg.criteria.title,
      adopted: reg.criteria.adopted,
      approvedBy: reg.criteria.approvedBy,
    },
    computedAt: now.toISOString(),
    portfolio: portfolioIndex(reg.criteria, apps),
    apps,
    problems: reg.problems,
    criteria: reg.criteria,
  };
}
