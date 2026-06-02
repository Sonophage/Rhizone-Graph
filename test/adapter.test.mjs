import assert from "node:assert/strict";
import test from "node:test";
import { recordFromCache } from "../src/obsidian/adapter.ts";

const cache = (c) => c;

test("facets come from both cache.links and cache.frontmatterLinks", () => {
  const r = recordFromCache("Movies - Dune.md", "Movies - Dune", cache({
    links: [{ link: "Science Fiction" }],
    frontmatterLinks: [{ link: "Director - Denis Villeneuve" }]
  }));
  assert.ok(r.facetKeys.includes("science fiction"));
  assert.ok(r.facetKeys.includes("denis villeneuve")); // "Director - " prefix stripped for matching
});

test("attachment links are excluded from facets", () => {
  const r = recordFromCache("X.md", "X", cache({ links: [{ link: "25.jpg" }, { link: "Gnosis" }] }));
  assert.ok(!r.facetKeys.some((k) => k.includes("jpg")));
  assert.ok(r.facetKeys.includes("gnosis"));
});

test("connections parsed from frontmatter: array form", () => {
  const r = recordFromCache("A.md", "A", cache({ frontmatter: { connections: ["[[Concept - Pleroma]]", "Gnosis"] } }));
  assert.deepEqual(r.connections, ["Concept - Pleroma", "Gnosis"]);
});

test("connections parsed: single-string and bare-wikilink forms", () => {
  const r1 = recordFromCache("A.md", "A", cache({ frontmatter: { connections: "[[Concept - Pleroma|Monad]]" } }));
  assert.deepEqual(r1.connections, ["Concept - Pleroma"]);
  const r2 = recordFromCache("A.md", "A", cache({ frontmatter: { connections: null } }));
  assert.deepEqual(r2.connections, []);
});

test("no cache at all yields an empty but valid record", () => {
  const r = recordFromCache("A.md", "A", null);
  assert.deepEqual(r.facetKeys, []);
  assert.deepEqual(r.connections, []);
  assert.deepEqual(r.linkPaths, []);
});

test("facetLabels keeps the human label for each key", () => {
  const r = recordFromCache("A.md", "A", cache({ links: [{ link: "Concept - Pleroma|Monad" }] }));
  assert.equal(r.facetLabels["pleroma"], "Concept - Pleroma");
});

test("connections and categories frontmatter links are NOT facets", () => {
  const r = recordFromCache("A.md", "A", cache({
    frontmatterLinks: [
      { link: "Concepts", key: "categories.0" }, // category -> excluded
      { link: "Concept - Gnosis", key: "connections.0" }, // curated layer -> excluded
      { link: "Gnosticism", key: "topics.0" } // real facet -> kept
    ]
  }));
  assert.deepEqual(r.facetKeys, ["gnosticism"]);
});
