import assert from "node:assert/strict";
import test from "node:test";
import { mergeConnection, removeConnection, isDangling } from "../src/obsidian/connections.ts";

test("forge adds a wikilink once; re-run is a no-op (idempotent self-heal)", () => {
  const a = mergeConnection([], "Concept - Pleroma");
  assert.deepEqual(a, ["[[Concept - Pleroma]]"]);
  assert.deepEqual(mergeConnection(a, "Concept - Pleroma"), a); // heal, no dup
});

test("dedupes across alias/path/extension forms", () => {
  assert.deepEqual(
    mergeConnection(["[[Concept - Pleroma]]"], "Concept - Pleroma|Monad"),
    ["[[Concept - Pleroma]]"]
  );
  assert.deepEqual(
    mergeConnection(["[[Concept - Pleroma]]"], "Folder/Concept - Pleroma.md"),
    ["[[Concept - Pleroma]]"]
  );
});

test("self-connection is refused (focus guard)", () => {
  assert.deepEqual(mergeConnection(["[[Me]]"], "Me", "Me"), ["[[Me]]"]);
  assert.deepEqual(mergeConnection([], "Me", "Me"), []);
});

test("removeConnection drops the matching entry by basename, leaves others", () => {
  const cur = ["[[Concept - Pleroma]]", "[[Gnosis]]"];
  assert.deepEqual(removeConnection(cur, "Concept - Pleroma|Monad"), ["[[Gnosis]]"]);
  assert.deepEqual(removeConnection(cur, "Nonexistent"), cur);
});

test("isDangling is true when the target basename resolves to no file", () => {
  const exists = new Set(["Concept - Pleroma"]);
  assert.ok(isDangling("[[Ghost Note]]", exists));
  assert.ok(!isDangling("[[Concept - Pleroma]]", exists));
  assert.ok(!isDangling("Concept - Pleroma", exists));
});
