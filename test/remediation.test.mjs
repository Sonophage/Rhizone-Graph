import assert from "node:assert/strict";
import test from "node:test";
import { remediationActions, planRemediation } from "../src/view/remediation.ts";

test("a dangling connection offers exactly reconnect, repoint, delete", () => {
  assert.deepEqual(remediationActions(true), ["reconnect", "repoint", "delete"]);
});

test("a healthy connection offers no remediation", () => {
  assert.deepEqual(remediationActions(false), []);
});

test("delete removes the dangling entry by basename", () => {
  assert.deepEqual(planRemediation(["[[Ghost]]", "[[Gnosis]]"], "delete", "Ghost"), ["[[Gnosis]]"]);
});

test("reconnect/repoint swap the old target for the chosen note", () => {
  assert.deepEqual(
    planRemediation(["[[Ghost]]"], "repoint", "Ghost", "Concept - Pleroma"),
    ["[[Concept - Pleroma]]"]
  );
});

test("reconnect without a chosen note is a no-op (requires a target)", () => {
  assert.deepEqual(planRemediation(["[[Ghost]]"], "reconnect", "Ghost"), ["[[Ghost]]"]);
});
