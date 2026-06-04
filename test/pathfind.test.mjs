import assert from "node:assert/strict";
import test from "node:test";
import { FacetIndex } from "../src/engine/index.ts";
import { normalizeFacet } from "../src/engine/alias.ts";
import { findPath } from "../src/engine/pathfind.ts";

function rec(path, facets) {
  return {
    path,
    basename: path.replace(/\.md$/, ""),
    facetKeys: facets.map(normalizeFacet),
    facetLabels: Object.fromEntries(facets.map((f) => [normalizeFacet(f), f])),
    linkPaths: [],
    connections: []
  };
}

// A chain: Gnosticism —(Philip K. Dick)→ Ubik —(Tyrell)→ Blade Runner.
// "Sci-Fi" is a thoroughfare on every note (high df) and must NOT be the chosen bridge.
const filler = [];
for (let i = 0; i < 70; i++) filler.push(rec(`f${i}.md`, ["Sci-Fi"]));
const records = [
  rec("Gnosticism.md", ["Sci-Fi", "Philip K. Dick"]),
  rec("Ubik.md", ["Sci-Fi", "Philip K. Dick", "Tyrell"]),
  rec("Blade Runner.md", ["Sci-Fi", "Tyrell"]),
  rec("Unrelated.md", ["Cooking"]),
  ...filler
];
const idx = new FacetIndex();
idx.addAll(records);

test("findPath traces the rare-facet chain, not the thoroughfare", () => {
  const p = findPath(idx, "Gnosticism.md", "Blade Runner.md");
  assert.ok(p, "a path exists");
  assert.deepEqual(p.notes, ["Gnosticism.md", "Ubik.md", "Blade Runner.md"]);
  assert.equal(p.hops.length, 2);
  assert.equal(p.hops[0].via, normalizeFacet("Philip K. Dick"));
  assert.equal(p.hops[1].via, normalizeFacet("Tyrell"));
});

test("findPath returns a trivial path for from===to", () => {
  const p = findPath(idx, "Ubik.md", "Ubik.md");
  assert.deepEqual(p, { notes: ["Ubik.md"], hops: [] });
});

test("findPath returns null when only thoroughfares connect them", () => {
  // Unrelated shares nothing rare with the chain → unreachable through stairs
  assert.equal(findPath(idx, "Gnosticism.md", "Unrelated.md"), null);
});

test("findPath skips blocked (hidden) waypoints", () => {
  const p = findPath(idx, "Gnosticism.md", "Blade Runner.md", { skip: (n) => n === "Ubik.md" });
  assert.equal(p, null, "the only bridge note is hidden → no path");
});
