import assert from "node:assert/strict";
import test from "node:test";
import { FacetIndex } from "../src/engine/index.ts";
import { normalizeFacet } from "../src/engine/alias.ts";

const rec = (path, facets) => ({
  path,
  basename: path.replace(/\.md$/, ""),
  facetKeys: facets.map(normalizeFacet),
  facetLabels: Object.fromEntries(facets.map((f) => [normalizeFacet(f), f])),
  linkPaths: [],
  connections: []
});

test("df = number of distinct notes carrying a facet (not occurrences)", () => {
  const idx = new FacetIndex();
  idx.addAll([rec("A.md", ["Gnosticism", "PKD"]), rec("B.md", ["Gnosticism"]), rec("C.md", ["PKD"])]);
  assert.equal(idx.df("gnosticism"), 2);
  assert.equal(idx.df("pkd"), 2);
  assert.equal(idx.notesWithFacet("gnosticism").size, 2);
});

test("duplicate facet in one note still counts that note once", () => {
  const idx = new FacetIndex();
  idx.addAll([rec("A.md", ["X", "X", "X"])]);
  assert.equal(idx.df("x"), 1);
});

test("incremental update reindexes only the changed note", () => {
  const idx = new FacetIndex();
  idx.addAll([rec("A.md", ["X"]), rec("B.md", ["X"])]);
  assert.equal(idx.df("x"), 2);
  idx.update(rec("A.md", ["Y"])); // A drops X, gains Y
  assert.equal(idx.df("x"), 1);
  assert.equal(idx.df("y"), 1);
});

test("remove drops the note's contribution and prunes empty facets", () => {
  const idx = new FacetIndex();
  idx.addAll([rec("A.md", ["Solo"])]);
  assert.equal(idx.df("solo"), 1);
  idx.remove("A.md");
  assert.equal(idx.df("solo"), 0);
  assert.equal(idx.get("A.md"), undefined);
});

test("unknown facet has df 0 and an empty set", () => {
  const idx = new FacetIndex();
  assert.equal(idx.df("nope"), 0);
  assert.equal(idx.notesWithFacet("nope").size, 0);
});
