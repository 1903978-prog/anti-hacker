import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import {
  addDomain,
  getEntry,
  listAllowlist,
  removeDomain,
  setActiveEligible,
  SEED_DOMAINS,
} from "../server/ownership/allowlist.js";
import { createChallenge, verifyOwnership, DNS_TXT_NAME } from "../server/ownership/proof.js";

describe("allowlist", () => {
  it("seeds the expected domains, all unproven", () => {
    const db = freshDb();
    const list = listAllowlist(db);
    expect(list.map((e) => e.domain).sort()).toEqual([...SEED_DOMAINS].sort());
    expect(list.every((e) => !e.ownershipProven && !e.activeEligible)).toBe(true);
  });

  it("normalizes a URL down to its host when adding", () => {
    const db = freshDb();
    const host = addDomain(db, "https://Example.com/some/path?q=1", "op");
    expect(host).toBe("example.com");
    expect(getEntry(db, "example.com")).not.toBeNull();
  });

  it("rejects garbage input", () => {
    const db = freshDb();
    expect(addDomain(db, "not a domain!!", "op")).toBeNull();
  });

  it("removes a domain", () => {
    const db = freshDb();
    expect(removeDomain(db, "eendigo.com", "op")).toBe(true);
    expect(getEntry(db, "eendigo.com")).toBeNull();
  });

  it("refuses active-eligible until ownership is proven", () => {
    const db = freshDb();
    expect(setActiveEligible(db, "eendigo.com", true, "op")).toBe(false);
    expect(getEntry(db, "eendigo.com")?.activeEligible).toBe(false);
  });
});

describe("proof of ownership", () => {
  it("verifies via DNS TXT when the issued token is present", async () => {
    const db = freshDb();
    const challenge = createChallenge(db, "eendigo.com", "op");
    expect(challenge).not.toBeNull();
    const token = challenge!.token;

    const resolveTxt = async (name: string) => {
      expect(name).toBe(DNS_TXT_NAME("eendigo.com"));
      return [["some-other"], [token]];
    };
    const result = await verifyOwnership(db, "eendigo.com", "dns-txt", "op", { resolveTxt });
    expect(result.verified).toBe(true);
    expect(getEntry(db, "eendigo.com")?.ownershipProven).toBe(true);
  });

  it("fails closed when the TXT token is absent", async () => {
    const db = freshDb();
    createChallenge(db, "eendigo.com", "op");
    const resolveTxt = async () => [["unrelated"]];
    const result = await verifyOwnership(db, "eendigo.com", "dns-txt", "op", { resolveTxt });
    expect(result.verified).toBe(false);
    expect(getEntry(db, "eendigo.com")?.ownershipProven).toBe(false);
  });

  it("fails closed when a resolver throws", async () => {
    const db = freshDb();
    createChallenge(db, "eendigo.com", "op");
    const resolveTxt = async () => {
      throw new Error("ENOTFOUND");
    };
    const result = await verifyOwnership(db, "eendigo.com", "dns-txt", "op", { resolveTxt });
    expect(result.verified).toBe(false);
  });

  it("verifies via token file", async () => {
    const db = freshDb();
    const { token } = createChallenge(db, "10bonds.com", "op")!;
    const fetchTokenFile = async () => `# secval\n${token}\n`;
    const result = await verifyOwnership(db, "10bonds.com", "token-file", "op", { fetchTokenFile });
    expect(result.verified).toBe(true);
  });

  it("refuses verification without a challenge", async () => {
    const db = freshDb();
    const result = await verifyOwnership(db, "eendigo.com", "dns-txt", "op", {
      resolveTxt: async () => [["anything"]],
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/no challenge/);
  });

  it("allows active-eligible once ownership is proven", async () => {
    const db = freshDb();
    const { token } = createChallenge(db, "eendigo.com", "op")!;
    await verifyOwnership(db, "eendigo.com", "dns-txt", "op", {
      resolveTxt: async () => [[token]],
    });
    expect(setActiveEligible(db, "eendigo.com", true, "op")).toBe(true);
    expect(getEntry(db, "eendigo.com")?.activeEligible).toBe(true);
  });
});
