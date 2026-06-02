import assert from "node:assert/strict";
import test from "node:test";
import { FacetIndex } from "../src/engine/index.ts";
import { normalizeFacet } from "../src/engine/alias.ts";
import {
  buildFacetGraph,
  edgeBetween,
  rarityAltitude,
  detectCommunities,
  communities,
  bridgeScores
} from "../src/engine/facetGraph.ts";

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

// Two tight clusters joined by one rare BRIDGE facet (Simulation) and one common HUB (Concepts).
// Backing notes (no facets) make the chosen facet keys resolve to real notes; "Vlad" has none → phantom.
const records = [
  rec("a1.md", ["Sci-Fi", "Dystopia", "Philip K. Dick", "Concepts", "Simulation"]),
  rec("a2.md", ["Sci-Fi", "Dystopia", "Philip K. Dick", "Concepts", "Vlad"]),
  rec("a3.md", ["Sci-Fi", "Dystopia", "Philip K. Dick", "Concepts"]),
  rec("b1.md", ["Gnosticism", "Demiurge", "Sophia", "Concepts", "Simulation"]),
  rec("b2.md", ["Gnosticism", "Demiurge", "Sophia", "Concepts"]),
  rec("b3.md", ["Gnosticism", "Demiurge", "Sophia", "Concepts"]),
  // backing notes so these facet keys are REAL (basename normalizes to the key):
  rec("Sci-Fi.md", []), rec("Dystopia.md", []), rec("Philip K. Dick.md", []),
  rec("Gnosticism.md", []), rec("Demiurge.md", []), rec("Sophia.md", []),
  rec("Concepts.md", []), rec("Simulation.md", []),
  // an isolated pair sharing no hub — its own little community, bridges nothing:
  rec("c1.md", ["Foo", "Bar"])
];

const idx = new FacetIndex();
idx.addAll(records);
const g = buildFacetGraph(idx);

test("df reflects the index; the hub is the most-cited facet", () => {
  assert.equal(g.nodes.get("concepts").df, 6);
  assert.equal(g.nodes.get("sci-fi").df, 3);
  assert.equal(g.nodes.get("simulation").df, 2);
  assert.equal(g.nodes.get("vlad").df, 1);
  assert.equal(g.maxDf, 6);
});

test("phantom flag: a facet with no backing note is phantom; backed ones are not", () => {
  assert.equal(g.nodes.get("vlad").phantom, true);
  assert.equal(g.nodes.get("concepts").phantom, false);
  assert.equal(g.nodes.get("sci-fi").phantom, false);
});

test("affinity is rarity-aware Jaccard: inseparable facets = 1, hub co-occurrence < 1", () => {
  // Sci-Fi & Dystopia appear in exactly the same 3 notes → Jaccard 1.0
  assert.equal(edgeBetween(g, "sci-fi", "dystopia").affinity, 1);
  // Sci-Fi (df3) & Concepts (df6) share 3 notes → 3 / (3+6-3) = 0.5
  assert.equal(edgeBetween(g, "sci-fi", "concepts").affinity, 0.5);
  // the hub pulls weaker than a tight pair, as gravity should
  assert.ok(edgeBetween(g, "sci-fi", "concepts").affinity < edgeBetween(g, "sci-fi", "dystopia").affinity);
});

test("altitude = rarity: df1 → top (1), maxDf → floor (0), strictly monotonic", () => {
  assert.equal(rarityAltitude(1, 6), 1);
  assert.equal(rarityAltitude(6, 6), 0);
  assert.ok(rarityAltitude(2, 6) > rarityAltitude(3, 6));
  assert.ok(rarityAltitude(3, 6) > rarityAltitude(6, 6));
});

test("communities separate the two clusters", () => {
  const labels = detectCommunities(g);
  // each trio is internally consistent…
  assert.equal(labels.get("sci-fi"), labels.get("dystopia"));
  assert.equal(labels.get("sci-fi"), labels.get("philip k. dick"));
  assert.equal(labels.get("gnosticism"), labels.get("demiurge"));
  assert.equal(labels.get("gnosticism"), labels.get("sophia"));
  // …and the two clusters are distinct
  assert.notEqual(labels.get("sci-fi"), labels.get("gnosticism"));
  // at least two communities exist
  assert.ok(communities(labels).length >= 2);
});

test("bridge score: the rare cross-cluster facet wins; a cluster-internal facet scores 0", () => {
  const labels = detectCommunities(g);
  const scores = bridgeScores(g, labels);
  const sim = scores.get("simulation");
  assert.ok(sim > 0, "Simulation bridges two communities");
  // Simulation is the strongest bridge of all (rarest facet genuinely spanning two clusters)
  for (const [key, s] of scores) if (key !== "simulation") assert.ok(s <= sim, `${key} should not out-bridge Simulation`);
  // a facet co-occurring only within its own community (the isolated Foo/Bar pair) is not a bridge
  assert.equal(scores.get("bar"), 0);
  assert.equal(scores.get("foo"), 0);
});
