import test from "node:test";
import assert from "node:assert/strict";
import { chooseNext, linkedIssueNumber, summarizeChecks, taskState, LABEL } from "./engineering-orchestrator.mjs";

const issue = (number, labels, created_at = "2026-11-01T00:00:00Z") => ({ number, state: "open", labels: labels.map((name) => ({ name })), created_at });

test("selects one opted-in task by priority then age", () => {
  const chosen = chooseNext([issue(5, [LABEL.ready, "P2"]), issue(7, [LABEL.ready, "P1"]), issue(8, [LABEL.ready, "P1"], "2026-11-02T00:00:00Z")]);
  assert.equal(chosen.number, 7);
});

test("does not select blocked, active, review, release, or completed issues", () => {
  const blocked = [LABEL.active, LABEL.blocked, LABEL.review, LABEL.release, LABEL.completed];
  for (const state of blocked) assert.equal(chooseNext([issue(2, [LABEL.ready, state])]), null);
});

test("agent task states fail closed for unknown values", () => {
  assert.equal(taskState({ state: "in_progress" }), "active");
  assert.equal(taskState({ state: "waiting_for_user" }), "blocked");
  assert.equal(taskState({ state: "completed" }), "completed");
  assert.equal(taskState({ state: "timed_out" }), "failed");
  assert.equal(taskState({ state: "new-state" }), "unknown");
});

test("CI summary requires every reported check to pass", () => {
  assert.equal(summarizeChecks([{ status: "completed", conclusion: "success" }], [{ state: "success" }]), "success");
  assert.equal(summarizeChecks([{ status: "completed", conclusion: "failure" }], []), "failure");
  assert.equal(summarizeChecks([{ status: "in_progress", conclusion: null }], []), "pending");
  assert.equal(summarizeChecks([], []), "pending");
});

test("finds a closing issue reference without guessing unrelated numbers", () => {
  assert.equal(linkedIssueNumber("Fixes #42 after regression tests"), 42);
  assert.equal(linkedIssueNumber("Related issue 42"), null);
});

