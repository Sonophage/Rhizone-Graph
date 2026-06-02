import assert from "node:assert/strict";
import test from "node:test";
import { FacetIndex } from "../src/engine/index.ts";
import { normalizeFacet } from "../src/engine/alias.ts";
import { buildTree, SEPHIROT } from "../src/engine/tree.ts";

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

const records = [
  rec("a1.md", ["Sci-Fi", "Dystopia", "Philip K. Dick", "Concepts", "Simulation"]),
  rec("a2.md", ["Sci-Fi", "Dystopia", "Philip K. Dick", "Concepts", "Vlad"]),
  rec("a3.md", ["Sci-Fi", "Dystopia", "Philip K. Dick", "Concepts"]),
  rec("b1.md", ["Gnosticism", "Demiurge", "Sophia", "Concepts", "Simulation"]),
  rec("b2.md", ["Gnosticism", "Demiurge", "Sophia", "Concepts"]),
  rec("b3.md", ["Gnosticism", "Demiurge", "Sophia", "Concepts"]),
  rec("Sci-Fi.md", []), rec("Dystopia.md", []), rec("Philip K. Dick.md", []),
  rec("Gnosticism.md", []), rec("Demiurge.md", []), rec("Sophia.md", []),
  rec("Concepts.md", []), rec("Simulation.md", [])
];

const idx = new FacetIndex();
idx.addAll(records);
const tree = buildTree(idx);
const at = (name) => tree.gateways.find((x) => x.name === name);

test("ten gateways, canonical order", () => {
  assert.equal(tree.gateways.length, 10);
  assert.deepEqual(tree.gateways.map((x) => x.name), SEPHIROT.map((s) => s.name));
});

test("Malkuth = the single most-cited facet (the manifest ground), at the rarity floor", () => {
  assert.equal(at("Malkuth").facet?.key, "concepts");
  assert.equal(at("Malkuth").role, "ground");
  assert.equal(at("Malkuth").altitude, 0); // df === maxDf
});

test("the rare cross-cluster facet lands on the Middle Pillar as a bridge", () => {
  const sim = tree.gateways.find((x) => x.facet?.key === "simulation");
  assert.ok(sim, "Simulation should be assigned");
  assert.equal(sim.pillar, "middle");
  assert.equal(sim.role, "bridge");
});

test("Da'ath holds the phantom facets — and only phantoms", () => {
  const keys = tree.daath.map((f) => f.key);
  assert.ok(keys.includes("vlad"));
  for (const f of tree.daath) assert.equal(f.phantom, true);
});

test("no facet is assigned to two gateways", () => {
  const keys = tree.gateways.map((x) => x.facet?.key).filter(Boolean);
  assert.equal(keys.length, new Set(keys).size);
});

test("two communities found, on opposite pillars", () => {
  assert.ok(tree.communityA);
  assert.ok(tree.communityB);
  assert.notEqual(tree.communityA, tree.communityB);
});

test("rarer gateways sit higher than the common ground", () => {
  const kether = at("Kether");
  if (kether.facet) assert.ok(kether.altitude > at("Malkuth").altitude);
});

test("paths only connect gateways whose facets co-occur", () => {
  for (const p of tree.paths) {
    assert.ok(p.shared >= 1);
    assert.ok(p.affinity > 0);
  }
});
