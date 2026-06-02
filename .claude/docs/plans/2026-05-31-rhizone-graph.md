# Implementation Plan — Rhizone Graph

**Goal:** Ship a lightweight Obsidian plugin that renders a note's local connection-web (direct links +
`connections` + rarity-ranked co-citation candidates) as keyboard-navigable concentric SVG rings.

**Architecture:** A **pure engine** (`src/engine/`, zero Obsidian imports — inverted index, co-citation,
rarity ranking, alias-strip, ring layout math) behind a **thin Obsidian adapter** (`src/obsidian/` —
metadataCache→records, `processFrontMatter` writes) consumed by an **SVG view** (`src/view/`). The engine
is fully unit-tested before any Obsidian-coupled code exists.

**Tech stack:** TypeScript (ES2020, erasable-only syntax in `engine/` so Node can type-strip it),
esbuild bundle (`main.ts`→`main.js`, externals `obsidian`+codemirror+node builtins, cjs/es2018),
`tsc -noEmit -skipLibCheck` typecheck, Node built-in test runner (`node --test test/*.test.mjs`).
No runtime deps, no jest/vitest, no embeddings/network. Mirrors `Cortical-Engram-Cartograph` conventions.

**Design doc:** `./2026-05-31--design.md` (read for the full spec, the three-layer model, and success criteria).

> **Ordering note (deviation from "scaffold last"):** the engine is TDD'd, so a *minimal* scaffold
> (package.json/tsconfig/test runner) must exist first or no test can run. Task 1 lays the minimal
> toolchain; the cosmetic scaffold (README, ribbon icon, final manifest polish) lands at the end.

---

## Task 1 — Minimal scaffold (enable build + test)

**Files (Create):** `Rhizone-Graph/{manifest.json, versions.json, package.json, tsconfig.json,
esbuild.config.mjs, .gitignore, styles.css, main.ts}`

**Steps:**
- [ ] Create `manifest.json`:
```json
{
  "id": "rhizone-graph",
  "name": "Rhizone Graph",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "A local connection-web: direct links, curated connections, and rarity-ranked co-citation candidates as concentric rings.",
  "author": "Sonophage",
  "authorUrl": "https://github.com/Sonophage",
  "isDesktopOnly": false
}
```
- [ ] Create `versions.json`: `{ "0.1.0": "1.5.0" }`
- [ ] Create `package.json` (mirror Cartograph; `test` uses node:test):
```json
{
  "name": "rhizone-graph",
  "version": "0.1.0",
  "description": "A local connection-web for Obsidian.",
  "main": "main.js",
  "scripts": {
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "node --no-warnings --test test/*.test.mjs"
  },
  "keywords": ["obsidian", "plugin", "graph", "co-citation", "connections"],
  "author": "Sonophage",
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^20.11.30",
    "esbuild": "^0.21.5",
    "obsidian": "^1.5.12",
    "typescript": "^5.4.5"
  }
}
```
- [ ] Create `tsconfig.json` (copy Cartograph's; keep `allowImportingTsExtensions: true`, `strictNullChecks: true`; `include` = `["src/**/*.ts", "main.ts"]`).
- [ ] Create `esbuild.config.mjs` (copy Cartograph's verbatim; change the banner to `/* Rhizone Graph — Obsidian plugin by Sonophage. MIT. */`).
- [ ] Create `.gitignore`: `node_modules/`, `main.js`, `*.map`, `data.json`.
- [ ] Create empty `styles.css` and a stub `main.ts`:
```ts
import { Plugin } from "obsidian";
export default class RhizoneGraphPlugin extends Plugin {
  async onload(): Promise<void> {}
}
```
- [ ] Run `cd Rhizone-Graph && npm install`
- [ ] Run `npm run build` — expect `main.js` produced, exit 0.
- [ ] Run `npm test` — expect "tests 0 … pass 0" (runner works, no tests yet).

**Verify (`/cs-verify`, smoke mode):** `npm run build` exits 0 and `main.js` exists; `npm test` exits 0.

---

## Task 2 — Engine types (pure)

**Files (Create):** `src/engine/types.ts`

**Steps:**
- [ ] Define erasable-only types (no enums — use string unions so Node can strip):
```ts
export type NodeState = "connected" | "mentioned" | "candidate";

/** One note as the engine sees it. No Obsidian types. */
export interface NoteRecord {
  path: string;            // vault-relative, e.g. "Concept - The Demiurge.md"
  basename: string;        // "Concept - The Demiurge"
  facetKeys: string[];     // normalized facet keys (alias-stripped, attachments removed)
  facetLabels: Record<string, string>; // normalized key -> first-seen display label
  linkPaths: string[];     // resolved note→note targets (basenames) for "mentioned"
  connections: string[];   // basenames from the frontmatter `connections` property
}

export interface SharedFacet { key: string; label: string; df: number; }

export interface Candidate {
  path: string;
  basename: string;
  shared: SharedFacet[];   // rarest-first
  rarestDf: number;
  weight: number;          // Σ 1/df over shared
  state: NodeState;
  alreadyLinked: boolean;  // direct link or connection exists either direction
}

export interface LocalWeb {
  focus: string;
  inner: Candidate[];      // direct links + connections (state connected|mentioned)
  outer: Candidate[];      // co-citation candidates (state candidate), rarity-ranked
}
```
- [ ] Run `npx tsc -noEmit -skipLibCheck` — expect exit 0.

**Verify:** typecheck passes.

---

## Task 3 — Alias normalization (pure) + tests

**Files:** Create `src/engine/alias.ts`; Test `test/alias.test.mjs`

**Steps:**
- [ ] Write `test/alias.test.mjs` FIRST (RED):
```js
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFacet, isAttachment } from "../src/engine/alias.ts";

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
test("isAttachment flags media/base targets", () => {
  for (const a of ["25.jpg", "cover.PNG", "Daily.base", "doc.pdf"]) assert.ok(isAttachment(a));
  assert.ok(!isAttachment("Concept - Gnosis"));
});
```
- [ ] Run `npm test` — expect FAIL (module missing). **RED confirmed.**
- [ ] Implement `src/engine/alias.ts`:
```ts
const ATTACHMENT = /\.(jpe?g|png|gif|webp|svg|pdf|base)$/i;
// One leading "Capitalizedword - " organizational prefix (Concept -, Movies -).
// Single all-letters token only, so "Year 34 - …" is left intact.
const TYPE_PREFIX = /^[A-Z][A-Za-z]+ - /;

export function isAttachment(target: string): boolean {
  return ATTACHMENT.test(target.split("|")[0].split("#")[0].trim());
}

/** Normalize a wikilink target to a facet match-key. Matching only — never written to disk. */
export function normalizeFacet(target: string): string {
  let t = target.split("|")[0].split("#")[0].trim();
  t = t.replace(TYPE_PREFIX, "");
  return t.normalize("NFC").toLowerCase();
}

/** Human-readable label for a raw target (prefix kept, alias/section dropped). */
export function facetLabel(target: string): string {
  return target.split("|")[0].split("#")[0].trim();
}
```
- [ ] Run `npm test` — expect PASS. **GREEN.**

**Verify:** alias tests pass; typecheck clean. (Maps to: alias-strip is matching-only.)

---

## Task 4 — Inverted index + incremental update (pure) + tests

**Files:** Create `src/engine/index.ts`; Test `test/index.test.mjs`

**Steps:**
- [ ] Write `test/index.test.mjs` FIRST (RED): assert `df` counts notes-per-facet (not occurrences),
      attachments excluded, `update(record)` recomputes only the touched note's facets:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { FacetIndex } from "../src/engine/index.ts";
import { normalizeFacet } from "../src/engine/alias.ts";

const rec = (path, facets) => ({
  path, basename: path.replace(/\.md$/, ""),
  facetKeys: facets.map(normalizeFacet),
  facetLabels: Object.fromEntries(facets.map(f => [normalizeFacet(f), f])),
  linkPaths: [], connections: []
});

test("df = number of distinct notes carrying a facet", () => {
  const idx = new FacetIndex();
  idx.addAll([rec("A.md", ["Gnosticism", "PKD"]), rec("B.md", ["Gnosticism"]), rec("C.md", ["PKD"])]);
  assert.equal(idx.df("gnosticism"), 2);
  assert.equal(idx.df("pkd"), 2);
  assert.equal(idx.notesWithFacet("gnosticism").size, 2);
});
test("incremental update reindexes only the changed note", () => {
  const idx = new FacetIndex();
  idx.addAll([rec("A.md", ["X"]), rec("B.md", ["X"])]);
  assert.equal(idx.df("x"), 2);
  idx.update(rec("A.md", ["Y"]));          // A drops X, gains Y
  assert.equal(idx.df("x"), 1);
  assert.equal(idx.df("y"), 1);
});
```
- [ ] Run `npm test` — **RED.**
- [ ] Implement `src/engine/index.ts`:
```ts
import type { NoteRecord } from "./types.ts";

export class FacetIndex {
  private facetToNotes = new Map<string, Set<string>>(); // facetKey -> note paths
  private records = new Map<string, NoteRecord>();

  addAll(recs: NoteRecord[]): void { for (const r of recs) this.add(r); }

  add(r: NoteRecord): void {
    this.records.set(r.path, r);
    for (const key of new Set(r.facetKeys)) {
      let s = this.facetToNotes.get(key);
      if (!s) this.facetToNotes.set(key, (s = new Set()));
      s.add(r.path);
    }
  }

  /** Remove a note's contribution, then re-add from the new record. O(facets of that note). */
  update(r: NoteRecord): void {
    this.remove(r.path);
    this.add(r);
  }

  remove(path: string): void {
    const old = this.records.get(path);
    if (!old) return;
    for (const key of new Set(old.facetKeys)) {
      const s = this.facetToNotes.get(key);
      if (s) { s.delete(path); if (s.size === 0) this.facetToNotes.delete(key); }
    }
    this.records.delete(path);
  }

  df(facetKey: string): number { return this.facetToNotes.get(facetKey)?.size ?? 0; }
  notesWithFacet(facetKey: string): Set<string> { return this.facetToNotes.get(facetKey) ?? new Set(); }
  get(path: string): NoteRecord | undefined { return this.records.get(path); }
  all(): IterableIterator<NoteRecord> { return this.records.values(); }
}
```
- [ ] Run `npm test` — **GREEN.**

**Verify:** index tests pass. (Maps to: incremental re-index, no full rescan.)

---

## Task 5 — Co-citation + rarity ranking (pure) + GOLDEN test ⭐

**Files:** Create `src/engine/cocitation.ts`; Test `test/cocitation.test.mjs`

> This is the regression oracle. The golden test reproduces the validated Demiurge ranking.

**Steps:**
- [ ] Write `test/cocitation.test.mjs` FIRST (RED). Fixture mirrors the measured vault so df lands right
      (PKD df3, the df2 esoteric cluster, Religion df9, Concepts df21):
```js
import assert from "node:assert/strict";
import test from "node:test";
import { FacetIndex } from "../src/engine/index.ts";
import { buildLocalWeb } from "../src/engine/cocitation.ts";
import { normalizeFacet } from "../src/engine/alias.ts";

function rec(path, facets, { links = [], connections = [] } = {}) {
  return {
    path, basename: path.replace(/\.md$/, ""),
    facetKeys: facets.map(normalizeFacet),
    facetLabels: Object.fromEntries(facets.map(f => [normalizeFacet(f), f])),
    linkPaths: links, connections
  };
}

// df-shaping notes so shared facets get the real document-frequencies.
const F = {
  pkd: ["Philip K. Dick"], religion: ["Religion"], concepts: ["Concepts"],
};
const records = [
  rec("Concept - The Demiurge.md", ["Esotericism","Aleister Crowley","Rosicrucianism","Freemasonry","Helena Blavatsky","Philip K. Dick","Simulation Theory","Religion","Concepts","Gnosticism"]),
  rec("Concept - The Great Architect.md", ["Esotericism","Aleister Crowley","Rosicrucianism","Freemasonry","Helena Blavatsky","Religion","Concepts","Gnosticism"]),
  rec("Concept - Gnosticism.md", ["Simulation Theory","Philip K. Dick","Religion","Concepts","Gnosticism"]),
  rec("Movies - Blade Runner 2049.md", ["Philip K. Dick","Concepts"]),
  rec("Concept - Particle Decay Width.md", ["Concepts"]),
  // df-padding so PKD df=3, Religion df=9-ish, Concepts df=21-ish, df2 cluster stays rare:
  rec("pad - sim.md", ["Simulation Theory"]),
  rec("pad - eso1.md", ["Esotericism"]), rec("pad - crowley.md", ["Aleister Crowley"]),
  rec("pad - rosi.md", ["Rosicrucianism"]), rec("pad - free.md", ["Freemasonry"]),
  rec("pad - blav.md", ["Helena Blavatsky"]),
  ...Array.from({length: 7}, (_, i) => rec(`pad-rel${i}.md`, ["Religion"])),
  ...Array.from({length: 19}, (_, i) => rec(`pad-con${i}.md`, ["Concepts"])),
];

const idx = new FacetIndex(); idx.addAll(records);
const web = buildLocalWeb("Concept - The Demiurge.md", idx);

test("Great Architect ranks #1 (densest rare-facet overlap)", () => {
  assert.equal(web.outer.length > 0 && web.outer[0].basename, "Concept - The Great Architect");
});
test("Blade Runner 2049 surfaces — via Philip K. Dick", () => {
  const br = web.outer.find(c => c.basename === "Movies - Blade Runner 2049");
  assert.ok(br, "Blade Runner present");
  assert.equal(br.shared[0].label, "Philip K. Dick"); // rarest-first
});
test("rarity beats count: Blade Runner (1 rare facet) outranks Particle Decay Width (only Concepts)", () => {
  const pos = b => web.outer.findIndex(c => c.basename === b);
  assert.ok(pos("Movies - Blade Runner 2049") < pos("Concept - Particle Decay Width"));
});
test("ranking key is (rarestDf asc, weight desc): all df2 candidates precede the df3 Blade Runner", () => {
  const br = web.outer.findIndex(c => c.basename === "Movies - Blade Runner 2049");
  for (let i = 0; i < br; i++) assert.ok(web.outer[i].rarestDf <= web.outer[br].rarestDf);
});
```
- [ ] Run `npm test` — **RED.**
- [ ] Implement `src/engine/cocitation.ts`:
```ts
import type { Candidate, LocalWeb, NoteRecord, SharedFacet, NodeState } from "./types.ts";
import type { FacetIndex } from "./index.ts";

const TOP_OUTER = 10; // default visible candidates; pagination handled in the view

export function buildLocalWeb(focusPath: string, idx: FacetIndex): LocalWeb {
  const focus = idx.get(focusPath);
  if (!focus) return { focus: focusPath, inner: [], outer: [] };

  const focusFacets = new Set(focus.facetKeys);
  const linked = new Set(focus.linkPaths.map(strip));   // basenames focus mentions
  const connected = new Set(focus.connections.map(strip));

  const cands: Candidate[] = [];
  for (const other of idx.all()) {
    if (other.path === focusPath) continue;
    const shared: SharedFacet[] = [];
    for (const key of new Set(other.facetKeys)) {
      if (!focusFacets.has(key)) continue;
      shared.push({ key, label: other.facetLabels[key] ?? key, df: idx.df(key) });
    }
    const back = other.connections.map(strip).includes(focus.basename)
              || other.linkPaths.map(strip).includes(focus.basename);
    const isConnected = connected.has(other.basename) || other.connections.map(strip).includes(focus.basename);
    const isMentioned = linked.has(other.basename) || other.linkPaths.map(strip).includes(focus.basename);
    if (shared.length === 0 && !isConnected && !isMentioned) continue;

    shared.sort((a, b) => a.df - b.df || a.label.localeCompare(b.label)); // rarest-first
    const state: NodeState = isConnected ? "connected" : isMentioned ? "mentioned" : "candidate";
    cands.push({
      path: other.path, basename: other.basename, shared,
      rarestDf: shared.length ? shared[0].df : Number.MAX_SAFE_INTEGER,
      weight: shared.reduce((s, f) => s + 1 / f.df, 0),
      state, alreadyLinked: isConnected || isMentioned || back
    });
  }

  // rarity beats count: rarest shared facet first, then weighted sum, then name.
  const byRarity = (a: Candidate, b: Candidate) =>
    a.rarestDf - b.rarestDf || b.weight - a.weight || a.basename.localeCompare(b.basename);

  const inner = cands.filter(c => c.state !== "candidate").sort(byRarity);
  const outer = cands.filter(c => c.state === "candidate").sort(byRarity);
  return { focus: focusPath, inner, outer };
}

function strip(s: string): string { return s.split("|")[0].split("#")[0].split("/").pop()!.replace(/\.md$/i, "").trim(); }
```
> Note: TOP_OUTER cap is applied in the view (Task 9), not here, so tests see the full ranking.
- [ ] Run `npm test` — **GREEN. All four golden assertions pass.**

**Verify (`/cs-verify`):** golden tests pass — Great Architect #1, Blade Runner via PKD, rarity beats count.
**This is a hard ship-gate success criterion.**

---

## Task 6 — Ring layout math (pure) + tests

**Files:** Create `src/engine/layout.ts`; Test `test/layout.test.mjs`

**Steps:**
- [ ] Write `test/layout.test.mjs` FIRST (RED): N nodes on a ring get evenly-spaced angles within
      `[0,2π)`, radius matches the ring, and an empty ring yields `[]`.
- [ ] Implement pure `placeRing(count, radius, cx, cy, startAngle=-Math.PI/2)` → `{x,y,angle}[]`
      and `ringRadii(viewSize)` → `{ inner, outer }`. No DOM.
- [ ] Run `npm test` — **GREEN.**

**Verify:** layout tests pass (deterministic coordinates).

---

## Task 7 — Obsidian adapter: metadataCache → records

**Files:** Create `src/obsidian/adapter.ts`; Test `test/adapter.test.mjs`

**Steps:**
- [ ] Write `test/adapter.test.mjs` FIRST (RED) using plain mock cache objects (mirror Cartograph's
      `note()` helper). Assert: links come from `cache.links` + `cache.frontmatterLinks`; attachments
      excluded; `connections` parsed from `cache.frontmatter.connections` (array OR single string OR
      `[[wikilink]]`); alias-strip applied to facet keys.
```js
// records come from a pure function so it is testable without Obsidian:
import { recordFromCache } from "../src/obsidian/adapter.ts";
```
- [ ] Run `npm test` — **RED.**
- [ ] Implement `src/obsidian/adapter.ts` with a **pure** `recordFromCache(path, basename, cache)` core
      (testable) and a thin `buildRecords(app)` wrapper that walks `app.vault.getMarkdownFiles()` and
      `app.metadataCache.getFileCache(file)`:
```ts
import type { App, CachedMetadata } from "obsidian";
import type { NoteRecord } from "../engine/types.ts";
import { isAttachment, normalizeFacet, facetLabel } from "../engine/alias.ts";

export function recordFromCache(path: string, basename: string, cache: CachedMetadata | null): NoteRecord {
  const facetKeys: string[] = [];
  const facetLabels: Record<string, string> = {};
  const links = [ ...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? []) ];
  for (const l of links) {
    if (isAttachment(l.link)) continue;
    const key = normalizeFacet(l.link);
    if (!key) continue;
    facetKeys.push(key);
    if (!facetLabels[key]) facetLabels[key] = facetLabel(l.link);
  }
  // "connections" frontmatter: array | string | "[[wikilink]]"
  const raw = cache?.frontmatter?.connections;
  const connections = toBasenames(raw);
  // resolved note→note links (for "mentioned"): same link set, as basenames
  const linkPaths = links.map(l => l.link.split("|")[0].split("#")[0].split("/").pop()!.replace(/\.md$/i, "").trim());
  return { path, basename, facetKeys, facetLabels, linkPaths, connections };
}

function toBasenames(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return arr.map(String)
    .map(s => s.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0].split("/").pop()!.replace(/\.md$/i, "").trim())
    .filter(Boolean);
}

export function buildRecords(app: App): NoteRecord[] {
  return app.vault.getMarkdownFiles().map(f =>
    recordFromCache(f.path, f.basename, app.metadataCache.getFileCache(f)));
}
```
- [ ] Run `npm test` — **GREEN.**

**Verify:** adapter tests pass; links sourced only from metadataCache (no regex parsing of bodies).

---

## Task 8 — Connections writer: bidirectional forge + idempotency + dangling detection

**Files:** Create `src/obsidian/connections.ts`; Test `test/connections.test.mjs`

**Steps:**
- [ ] Write `test/connections.test.mjs` FIRST (RED). Test the **pure** merge helper that decides the next
      `connections` array — that's where idempotency lives; the `processFrontMatter` call is a thin wrapper:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { mergeConnection, isDangling } from "../src/obsidian/connections.ts";

test("forge adds a wikilink once; re-run is a no-op (idempotent)", () => {
  const a = mergeConnection([], "Concept - Pleroma");
  assert.deepEqual(a, ["[[Concept - Pleroma]]"]);
  assert.deepEqual(mergeConnection(a, "Concept - Pleroma"), a); // heal, no dup
});
test("dedupes across alias/path forms and ignores self", () => {
  assert.deepEqual(mergeConnection(["[[Concept - Pleroma]]"], "Concept - Pleroma|Monad"), ["[[Concept - Pleroma]]"]);
  assert.deepEqual(mergeConnection(["[[Me]]"], "Me", "Me"), ["[[Me]]"]); // self guard via focus arg
});
test("isDangling true when target basename resolves to no file", () => {
  const exists = new Set(["Concept - Pleroma"]);
  assert.ok(isDangling("[[Ghost Note]]", exists));
  assert.ok(!isDangling("[[Concept - Pleroma]]", exists));
});
```
- [ ] Run `npm test` — **RED.**
- [ ] Implement `src/obsidian/connections.ts`:
```ts
import type { App, TFile } from "obsidian";

const base = (s: string) => s.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0].split("/").pop()!.replace(/\.md$/i, "").trim();

/** Pure: return the next connections array. Idempotent, deduped, self-guarded. */
export function mergeConnection(current: string[], targetBasename: string, focusBasename?: string): string[] {
  const t = base(targetBasename);
  if (!t || t === focusBasename) return current;
  if (current.some(c => base(c) === t)) return current;       // already present → heal/no-op
  return [...current, `[[${t}]]`];
}

export function removeConnection(current: string[], targetBasename: string): string[] {
  const t = base(targetBasename);
  return current.filter(c => base(c) !== t);
}

export function isDangling(entry: string, existingBasenames: Set<string>): boolean {
  return !existingBasenames.has(base(entry));
}

/** Thin Obsidian wrapper — the ONLY way connections are written. Bidirectional + idempotent. */
export async function forge(app: App, aFile: TFile, bFile: TFile): Promise<void> {
  await writeOne(app, aFile, bFile.basename);
  await writeOne(app, bFile, aFile.basename);   // sequenced; re-run heals a half-written pair
}

async function writeOne(app: App, file: TFile, targetBasename: string): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    const cur: string[] = Array.isArray(fm.connections) ? fm.connections
                        : fm.connections == null ? [] : [String(fm.connections)];
    fm.connections = mergeConnection(cur, targetBasename, file.basename);
  });
}

export async function unforge(app: App, file: TFile, targetBasename: string): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    const cur: string[] = Array.isArray(fm.connections) ? fm.connections : fm.connections == null ? [] : [String(fm.connections)];
    fm.connections = removeConnection(cur, targetBasename);
  });
}
```
- [ ] Run `npm test` — **GREEN.**
- [ ] `grep -rn "processFrontMatter" src/` — confirm it's the ONLY frontmatter write path; `grep -rn "\\.modify\\|writeFile\\|\\.vault\\.process" src/` returns nothing for `connections`.

**Verify (`/cs-verify`):** idempotency test passes (re-run heals, never duplicates); no manual YAML writes (grep gate).

---

## Task 9 — SVG ring view (ItemView)

**Files:** Create `src/view/ringView.ts`; Modify `styles.css`

**Steps:**
- [ ] Implement `RHIZONE_VIEW_TYPE` + `class RhizoneView extends ItemView`. On render: build records →
      `FacetIndex` (from a shared plugin-held index, Task 12) → `buildLocalWeb(focus, idx)`.
- [ ] Draw center node + inner ring (`web.inner`) + outer ring (`web.outer`), capping outer at
      `TOP_OUTER (10)` with a **"show more (N)"** control that pages the remainder.
- [ ] **Multi-channel state encoding** (each node):
      - brightness via `fill-opacity` (connected 1.0 / mentioned 0.45 / candidate 1.0 but in candidate color),
      - **stroke style** (connected solid, mentioned dashed, candidate dotted),
      - **state glyph** label prefix (`● ○ ◇`),
      - `aria-label` = `"{basename} — {state}; shared: {top shared labels}"`.
- [ ] All colors via CSS custom properties in `styles.css` (`--rg-connected`, `--rg-candidate`,
      `--rg-mentioned`, stroke widths) so Bureau dark/daylight/glass/CRT themes drive it. No hardcoded hex.
- [ ] Persistent **legend** block (the ● ○ ◇ key) rendered in a corner.
- [ ] Use SVG elements via `createSvg`/`createEl`; **no `innerHTML`**.
- [ ] Smoke: build, symlink not required yet — load in a scratch vault OR defer full smoke to Task 15.

**Verify:** `npm run build` clean; manual: view opens and renders center + two rings with a legend.
(Maps to: SVG renderer, multi-channel state, top-10 + show-more, theme tokens.)

---

## Task 10 — Interaction: traverse, breadcrumb, keyboard, hover-why

**Files:** Create `src/view/interaction.ts`; Test `test/breadcrumb.test.mjs`

**Steps:**
- [ ] Write `test/breadcrumb.test.mjs` FIRST (RED) for the **pure** breadcrumb stack: push on traverse,
      clicking an earlier crumb truncates the trail, no consecutive duplicates.
- [ ] Implement pure `BreadcrumbTrail` (push/jumpTo/current) — no DOM. **GREEN.**
- [ ] Wire view interactions:
      - click any node (inner or outer) → set focus to its path, push breadcrumb, re-render.
      - **keyboard:** `Tab`/`Shift+Tab` cycle ring nodes (roving tabindex), `Enter` traverse focused node,
        `F` forge focused candidate, `Esc` back one crumb.
      - hover/focus a candidate → a "why" tooltip listing `shared` labels **rarest-first** (instant).
- [ ] Render the clickable breadcrumb trail above the rings.

**Verify:** breadcrumb unit test passes; manual: keyboard-only traverse+forge works end-to-end.
(Maps to: keyboard-first; serendipity regenerates per hop.)

---

## Task 11 — Inline note preview

**Files:** Create `src/view/preview.ts`

**Steps:**
- [ ] On focus/hover of any node, render an inline preview pane using
      `MarkdownRenderer.render(app, content, el, path, component)` (read body via `app.vault.cachedRead`).
      Never `innerHTML`.
- [ ] Clean up child components on re-render to avoid leaks (`Component`/`addChild`).

**Verify:** manual: preview shows note content; no console errors on rapid re-focus.

---

## Task 12 — Wire main.ts: view registration, index lifecycle, commands, menus

**Files:** Modify `main.ts`

**Steps:**
- [ ] Hold a single `FacetIndex`. On `onload`/`metadataCache.on("resolved")` do a one-time
      `buildRecords(app)` → `index.addAll`.
- [ ] On `metadataCache.on("changed", file)` → `index.update(recordFromCache(...))` for **that file only**
      (incremental), then refresh the active view (debounced).
- [ ] On `vault.on("rename"/"delete")` → update/remove the record and re-flag dangling connections.
- [ ] `registerView(RHIZONE_VIEW_TYPE, leaf => new RhizoneView(leaf, this))`.
- [ ] Commands: "Open Rhizone Graph for current note", "Forge connection to…", "Back (breadcrumb)".
      Ribbon icon (`git-fork` or `share-2`). `file-menu` item "Open in Rhizone Graph".
- [ ] `addSettingTab` (minimal: TOP_OUTER count, toggle show-already-linked-dimmed).

**Verify:** `npm run build` clean; manual: changing a note updates candidates without a full rescan
(add a shared facet to two notes → they appear as candidates immediately).

---

## Task 13 — Dangling-connection remediation module

**Files:** Create `src/view/remediation.ts`; Test `test/remediation.test.mjs`

**Steps:**
- [ ] Write `test/remediation.test.mjs` FIRST (RED) for the **pure** decision logic: given a dangling
      entry, the offered actions are exactly `["reconnect","repoint","delete"]`; reconnect requires a
      chosen existing note; delete calls `removeConnection`.
- [ ] Implement: dangling entries (from `isDangling`) render with a warning glyph in the inner ring.
      Selecting one opens a small menu — **Reconnect** (fuzzy-pick an existing note, rewrites entry via
      `processFrontMatter`), **Repoint** (same, to any/new note), **Delete connection** (`unforge`).
      Bidirectional where applicable.
- [ ] **GREEN.**

**Verify:** remediation unit test passes; manual: rename a connected note → entry flags (not pruned) →
remediate via each of the three actions.
(Maps to: dangling flagged, not auto-pruned; remediable.)

---

## Task 14 — styles.css polish + grayscale check

**Files:** Modify `styles.css`

**Steps:**
- [ ] Finalize CSS tokens; ensure connected/mentioned/candidate differ by **stroke + glyph**, not color
      alone. Add focus-ring styles for keyboard nav. Respect `prefers-reduced-motion`.
- [ ] Grayscale check: screenshot the view, desaturate — all three states must remain distinguishable.

**Verify (`/cs-verify`):** grayscale-distinguishable states (success criterion).

---

## Task 15 — README, finalize, vault symlink, end-to-end smoke

**Files:** Create `README.md`; Create symlink

**Steps:**
- [ ] Write `README.md`: the three-layer model, the **non-goals** (no global graph, no embeddings, no
      auto-population), keyboard map, and *why phantom co-citation is the primary signal* (the insight
      future-you forgets).
- [ ] `ln -s "/home/sonophage/Documents/00-00-System/00-Git-Repositories/Sonophage/Rhizone-Graph" \
        "/home/sonophage/Documents/01-09-Obsidian-Vaults/Harker/.obsidian/plugins/rhizone-graph"`
- [ ] `npm run build` → enable plugin in Obsidian → open on **`Concept - The Demiurge`**.
- [ ] End-to-end smoke: inner ring shows `The Great Architect`/`Gnosticism` (connected/mentioned);
      outer ring shows `Blade Runner 2049` (bright candidate) with "why: Philip K. Dick"; forge it →
      appears in both notes' `connections:`; traverse into it → rings recompute; rename a connected note →
      dangling flag → remediate.

**Verify (`/cs-verify`, full smoke):** the end-to-end loop above works; all success criteria checked:
- [ ] golden engine tests green · [ ] forge idempotent · [ ] no manual YAML (grep) · [ ] keyboard nav ·
- [ ] grayscale-distinguishable · [ ] incremental re-index · [ ] dangling flagged + remediable.

---

## Execution order summary

`1 scaffold → 2 types → 3 alias → 4 index → 5 cocitation(GOLDEN) → 6 layout → 7 adapter →
8 connections(idempotency) → 9 view → 10 interaction → 11 preview → 12 main wiring →
13 remediation → 14 styles → 15 README+symlink+smoke`

Tasks 2–8 are pure/adapter logic, fully unit-tested **before** any view code (amendment #1).
Code-review checkpoints after Task 5 (engine core), Task 8 (writes), Task 12 (wiring).
