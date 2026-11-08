import { describe, it, expect } from "vitest";
import request from "supertest";
import { freshDb } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createChallenge, verifyOwnership } from "../server/ownership/proof.js";
import { checkDatabase, type JsonFetch } from "../server/health/dbcheck.js";
import { measurementStatus, outcomeOf } from "../server/health/measurement.js";

const HOST = "compplan.onrender.com";
const NOW = new Date("2026-11-08T12:00:00Z");
const SECRET = "q".repeat(30);
const answer = (status: number, body: unknown = {}): JsonFetch => async () => ({ status, text: JSON.stringify(body) });

async function proven() {
  const db = freshDb();
  const { token } = createChallenge(db, HOST, "op")!;
  await verifyOwnership(db, HOST, "dns-txt", "op", { resolveTxt: async () => [[token]] });
  return db;
}

describe("public measurement status (five-app certification P0)", () => {
  it("says which tokens are configured by name and yes/no, never their values", async () => {
    const db = await proven();
    const env = { SECVAL_DBCHECK_TOKEN: "secret-dbcheck-value", SECVAL_QUALITY_TOKENS: `nexus-eendigo=${SECRET},compplan=${SECRET}`, RENDER_GIT_COMMIT: "52fd0dca4cd8e7c853e4dfde77818ccbec8e9aaa" };
    const m = measurementStatus(db, env);
    expect(m).toMatchObject({ commit: "52fd0dca4cd8", dbCheckTokenSet: true, qualityTokenApps: ["compplan", "nexus-eendigo"] });
    const text = JSON.stringify(m);
    expect(text).not.toContain("secret-dbcheck-value");
    expect(text).not.toContain(SECRET);
    expect(measurementStatus(db, {})).toMatchObject({ commit: null, dbCheckTokenSet: false, qualityTokenApps: [] });
  });

  it("gives each app's last database answer as a coarse outcome, no score or error text", async () => {
    const db = await proven();
    expect(measurementStatus(db, {}).databases.find((d) => d.host === HOST)).toEqual({ host: HOST, lastCheckAt: null, outcome: "none" });
    await checkDatabase(db, HOST, "tok", answer(401), () => NOW);
    const d = measurementStatus(db, {}).databases.find((x) => x.host === HOST)!;
    expect(d).toEqual({ host: HOST, lastCheckAt: NOW.toISOString(), outcome: "refused" });
    expect(Object.keys(d)).not.toContain("score");
  });

  it("classifies outcomes", () => {
    expect(outcomeOf(true, null)).toBe("measured");
    expect(outcomeOf(false, "status 403")).toBe("refused");
    expect(outcomeOf(false, "report is stale (checked x)")).toBe("stale");
    expect(outcomeOf(false, "bad report: tables")).toBe("bad-answer");
    expect(outcomeOf(false, "fetch failed")).toBe("unreachable");
  });

  it("is part of the public /health answer", async () => {
    const res = await request(createApp(freshDb(), { apiToken: "t".repeat(20) })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.measurement).toMatchObject({ dbCheckTokenSet: expect.any(Boolean), qualityTokenApps: expect.any(Array) });
  });
});
