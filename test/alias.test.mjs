import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFacet, isAttachment, facetLabel } from "../src/engine/alias.ts";

test("strips a single capitalized type prefix: Concept - X ≡ X", () => {
  assert.equal(normalizeFacet("Concept - The Archons"), normalizeFacet("The Archons"));
  assert.equal(normalizeFacet("Movies - Dune"), normalizeFacet("Dune"));
});

test("does NOT over-strip multi-word/numbered prefixes", () => {
  // "Year 34 - Sector 7" must stay distinct from "Sector 7"
  assert.notEqual(normalizeFacet("Year 34 - Sector 7"), normalizeFacet("Sector 7"));
});

test("drops section + alias and is case-insensitive", () => {
  assert.equal(normalizeFacet("Concept - Pleroma|Monad"), normalizeFacet("pleroma"));
  assert.equal(normalizeFacet("Gnosticism#History"), normalizeFacet("Gnosticism"));
});

test("isAttachment flags media/base targets, not notes", () => {
  for (const a of ["25.jpg", "cover.PNG", "Daily.base", "doc.pdf", "x.webp", "y.svg"]) {
    assert.ok(isAttachment(a), `${a} should be an attachment`);
  }
  assert.ok(!isAttachment("Concept - Gnosis"));
  assert.ok(!isAttachment("Philip K. Dick"));
});

test("facetLabel keeps the human form (prefix kept, alias/section dropped)", () => {
  assert.equal(facetLabel("Concept - Pleroma|Monad"), "Concept - Pleroma");
  assert.equal(facetLabel("Gnosticism#History"), "Gnosticism");
});
