import assert from "node:assert/strict";
import test from "node:test";
import { FacetIndex } from "../src/engine/index.ts";
import { buildLocalWeb } from "../src/engine/cocitation.ts";
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

// Fixture mirrors the measured Harker vault so document-frequencies are faithful:
//   the esoteric cluster shared only by Demiurge+Great Architect -> df 2 (rare),
//   Philip K. Dick -> df 3, Religion -> df 10, Concepts -> df 24 (junk-common).
const records = [
  rec("Concept - The Demiurge.md", [
    "Esotericism", "Aleister Crowley", "Rosicrucianism", "Freemasonry", "Helena Blavatsky",
    "Philip K. Dick", "Simulation Theory", "Religion", "Concepts", "Gnosticism"
  ]),
  rec("Concept - The Great Architect.md", [
    "Esotericism", "Aleister Crowley", "Rosicrucianism", "Freemasonry", "Helena Blavatsky",
    "Religion", "Concepts", "Gnosticism"
  ]),
  rec("Concept - Gnosticism.md", ["Simulation Theory", "Philip K. Dick", "Religion", "Concepts", "Gnosticism"]),
  rec("Movies - Blade Runner 2049.md", ["Philip K. Dick", "Concepts"]),
  rec("Concept - Particle Decay Width.md", ["Concepts"]),
  // df padding so Religion ~10 and Concepts ~24 (common -> heavily down-weighted):
  ...Array.from({ length: 7 }, (_, i) => rec(`pad-rel${i}.md`, ["Religion"])),
  ...Array.from({ length: 19 }, (_, i) => rec(`pad-con${i}.md`, ["Concepts"]))
];

const idx = new FacetIndex();
idx.addAll(records);
const web = buildLocalWeb("Concept - The Demiurge.md", idx);

test("Great Architect ranks #1 (densest rare-facet overlap)", () => {
  assert.ok(web.outer.length > 0);
  assert.equal(web.outer[0].basename, "Concept - The Great Architect");
});

test("Blade Runner 2049 surfaces — and its top reason is Philip K. Dick", () => {
  const br = web.outer.find((c) => c.basename === "Movies - Blade Runner 2049");
  assert.ok(br, "Blade Runner should be a candidate");
  assert.equal(br.shared[0].label, "Philip K. Dick"); // rarest-first
});

test("rarity beats count: Blade Runner (1 rare facet) outranks Particle Decay Width (only Concepts)", () => {
  const pos = (b) => web.outer.findIndex((c) => c.basename === b);
  assert.ok(pos("Movies - Blade Runner 2049") < pos("Concept - Particle Decay Width"));
});

test("ranking key is (rarestDf asc, weight desc): all df2 candidates precede the df3 Blade Runner", () => {
  const br = web.outer.findIndex((c) => c.basename === "Movies - Blade Runner 2049");
  assert.equal(web.outer[br].rarestDf, 3);
  for (let i = 0; i < br; i++) assert.ok(web.outer[i].rarestDf <= 2);
});

test("connections/links route into the inner ring with the right state, not outer", () => {
  const recs2 = records.map((r) =>
    r.path === "Concept - The Demiurge.md"
      ? { ...r, connections: ["Concept - The Great Architect"], linkPaths: ["Concept - Gnosticism"] }
      : r
  );
  const idx2 = new FacetIndex();
  idx2.addAll(recs2);
  const web2 = buildLocalWeb("Concept - The Demiurge.md", idx2);
  const ga = web2.inner.find((c) => c.basename === "Concept - The Great Architect");
  const gn = web2.inner.find((c) => c.basename === "Concept - Gnosticism");
  assert.equal(ga?.state, "connected");
  assert.equal(gn?.state, "mentioned");
  // and they are no longer in the candidate ring:
  assert.ok(!web2.outer.some((c) => c.basename === "Concept - The Great Architect"));
});
