import assert from "node:assert/strict";
import test from "node:test";
import { FacetIndex } from "../src/engine/index.ts";
import { buildAtlas } from "../src/engine/atlas.ts";
import { normalizeFacet } from "../src/engine/alias.ts";

function rec(path, facets, { links = [], connections = [] } = {}) {
  return {
    path,
    basename: path.replace(/\.md$/, ""),
    facetKeys: facets.map(normalizeFacet),
    facetLabels: Object.fromEntries(facets.map((f) => [normalizeFacet(f), f])),
    linkPaths: links,
    connections
  };
}

// 12 genre hubs (df 3 each) + junk-common "Concepts" → the top-13 by df are the hubs.
// "A24" is genuinely RARE (df 2) yet bridges G00's cluster to G06's cluster — load-bearing.
// "Cyberpunk" is cited but never created → phantom; "Shoegaze" has a note → not phantom.
const records = [];
for (let g = 0; g < 12; g++) {
  const G = `G${String(g).padStart(2, "0")}`;
  for (let n = 0; n < 3; n++) records.push(rec(`Movies - ${G}-${n}.md`, [G, "Concepts"]));
}
// the bridge: A24 sits on one note from two different genre clusters
records.push(rec("Movies - Bridge A.md", ["G00", "Concepts", "A24"]));
records.push(rec("Movies - Bridge B.md", ["G06", "Concepts", "A24"]));
// a phantom facet (no note) and a resolved one (has a note)
records.push(rec("Movies - Has Cyberpunk.md", ["G01", "Concepts", "Cyberpunk"]));
records.push(rec("Movies - Has Shoegaze.md", ["G02", "Concepts", "Shoegaze"]));
records.push(rec("Concept - Shoegaze.md", ["Concepts"])); // resolves "Shoegaze"

const idx = new FacetIndex();
idx.addAll(records);
const atlas = buildAtlas(idx);
const byKey = (k) => atlas.facets.find((f) => f.key === normalizeFacet(k));

test("facets are ranked by document frequency", () => {
  assert.equal(atlas.facets[0].key, normalizeFacet("Concepts")); // most-cited → first
  assert.ok(atlas.facets[0].df >= byKey("A24").df);
});

test("hubs are the highest-df facets, the rare bridge is not one", () => {
  assert.ok(atlas.hubs.includes(normalizeFacet("Concepts")));
  assert.ok(!atlas.hubs.includes(normalizeFacet("A24")), "A24 is rare → not a hub");
});

test("phantom facets are those with no resolving note", () => {
  assert.equal(byKey("Cyberpunk").phantom, true); // never created as a note
  assert.equal(byKey("Shoegaze").phantom, false); // has a note
  assert.ok(atlas.phantoms.includes(normalizeFacet("Cyberpunk")));
});

test("co-occurrence edges are undirected, deduped, and weighted", () => {
  const e = atlas.edges.find(
    (x) =>
      (x.a === normalizeFacet("A24") && x.b === normalizeFacet("Concepts")) ||
      (x.b === normalizeFacet("A24") && x.a === normalizeFacet("Concepts"))
  );
  assert.ok(e, "A24 and Concepts co-occur");
  assert.equal(e.weight, 2); // Bridge A + Bridge B
});

test("A24 scores as a bridge — it links facets that don't otherwise meet", () => {
  const a24 = byKey("A24");
  assert.ok(a24.bridgeScore > 0, "A24 bridges open pairs (G00 ↔ G06)");
  assert.ok(atlas.bridges.includes(normalizeFacet("A24")));
});

test("each facet records its strongest co-occurring neighbour", () => {
  const a24 = byKey("A24");
  assert.ok(a24.cooccur.length > 0);
  assert.equal(a24.cooccur[0].key, normalizeFacet("Concepts")); // strongest (weight 2)
});

test("noteCount and facetCount reflect the index", () => {
  assert.equal(atlas.noteCount, idx.size());
  assert.equal(atlas.facetCount, atlas.facets.length);
});
