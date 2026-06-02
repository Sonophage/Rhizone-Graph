import assert from "node:assert/strict";
import test from "node:test";
import { BreadcrumbTrail } from "../src/view/interaction.ts";

test("push tracks the walk and reports current", () => {
  const t = new BreadcrumbTrail("A.md");
  assert.equal(t.current(), "A.md");
  t.push("B.md");
  t.push("C.md");
  assert.deepEqual(t.items(), ["A.md", "B.md", "C.md"]);
  assert.equal(t.current(), "C.md");
});

test("pushing the current node again is a no-op (no consecutive dupes)", () => {
  const t = new BreadcrumbTrail("A.md");
  t.push("A.md");
  t.push("B.md");
  t.push("B.md");
  assert.deepEqual(t.items(), ["A.md", "B.md"]);
});

test("jumpTo an earlier crumb truncates the trail", () => {
  const t = new BreadcrumbTrail("A.md");
  t.push("B.md");
  t.push("C.md");
  t.jumpTo(0);
  assert.deepEqual(t.items(), ["A.md"]);
  assert.equal(t.current(), "A.md");
});

test("back pops one and returns the new current; back at root is a no-op", () => {
  const t = new BreadcrumbTrail("A.md");
  t.push("B.md");
  assert.equal(t.back(), "A.md");
  assert.equal(t.back(), "A.md"); // already at root
  assert.deepEqual(t.items(), ["A.md"]);
});
