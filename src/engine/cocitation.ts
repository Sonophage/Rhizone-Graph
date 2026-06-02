import type { Candidate, LocalWeb, NodeState, SharedFacet } from "./types.ts";
import type { FacetIndex } from "./index.ts";
import { normalizeFacet } from "./alias.ts";

export interface PhantomFacet {
  key: string;
  label: string;
  /** how many notes mention this nonexistent target (its connection potential) */
  shared: number;
}

/**
 * The focus note's UNLINKED mentions: wikilink targets it references that resolve to no note.
 * Each carries how many notes mention the same phantom — the latent connections it could unlock.
 * Sorted by reach (most-shared first). PURE.
 */
export function phantomFacets(focusPath: string, idx: FacetIndex): PhantomFacet[] {
  const focus = idx.get(focusPath);
  if (!focus) return [];
  const existing = new Set<string>();
  for (const r of idx.all()) existing.add(normalizeFacet(r.basename)); // note names, as facet keys
  const seen = new Set<string>();
  const out: PhantomFacet[] = [];
  for (const key of focus.facetKeys) {
    if (!key || existing.has(key) || seen.has(key)) continue; // resolves to a real note → not phantom
    seen.add(key);
    out.push({ key, label: focus.facetLabels[key] ?? key, shared: idx.df(key) });
  }
  return out.sort((a, b) => b.shared - a.shared || a.label.localeCompare(b.label));
}

/**
 * Build a note's local web: inner ring (direct links + connections) and outer ring
 * (co-citation candidates), both ranked "rarity beats count" — the rarest shared facet
 * (lowest document-frequency) wins, with Σ(1/df) as the tiebreak. PURE.
 *
 * The TOP_OUTER cap is applied by the view, not here, so callers/tests see the full ranking.
 */
export function buildLocalWeb(focusPath: string, idx: FacetIndex): LocalWeb {
  const focus = idx.get(focusPath);
  if (!focus) return { focus: focusPath, inner: [], outer: [] };

  const focusFacets = new Set(focus.facetKeys);
  const focusLinks = new Set(focus.linkPaths.map(strip));
  const focusConns = new Set(focus.connections.map(strip));

  const cands: Candidate[] = [];
  for (const other of idx.all()) {
    if (other.path === focusPath) continue;

    const shared: SharedFacet[] = [];
    for (const key of new Set(other.facetKeys)) {
      if (!focusFacets.has(key)) continue;
      shared.push({ key, label: other.facetLabels[key] ?? key, df: idx.df(key) });
    }

    const otherConns = other.connections.map(strip);
    const otherLinks = other.linkPaths.map(strip);
    const isConnected = focusConns.has(other.basename) || otherConns.includes(focus.basename);
    const isMentioned = focusLinks.has(other.basename) || otherLinks.includes(focus.basename);
    // direction: who DECLARED the relationship. focus declares → outbound; other declares → inbound.
    const outbound = focusConns.has(other.basename) || focusLinks.has(other.basename);
    const inbound = otherConns.includes(focus.basename) || otherLinks.includes(focus.basename);

    if (shared.length === 0 && !isConnected && !isMentioned) continue;

    shared.sort((a, b) => a.df - b.df || a.label.localeCompare(b.label)); // rarest-first
    const state: NodeState = isConnected ? "connected" : isMentioned ? "mentioned" : "candidate";
    cands.push({
      path: other.path,
      basename: other.basename,
      shared,
      rarestDf: shared.length ? shared[0].df : Number.MAX_SAFE_INTEGER,
      weight: shared.reduce((s, f) => s + 1 / f.df, 0),
      state,
      outbound,
      inbound,
      alreadyLinked: isConnected || isMentioned
    });
  }

  cands.sort(byRarity);
  const inner = cands.filter((c) => c.state !== "candidate");

  // Dangling connections: curated targets that resolve to no emitted note. Flagged, never pruned.
  const emitted = new Set(inner.map((c) => c.basename));
  for (const conn of focus.connections.map(strip)) {
    if (!conn || emitted.has(conn)) continue;
    inner.push({
      path: "",
      basename: conn,
      shared: [],
      rarestDf: Number.MAX_SAFE_INTEGER,
      weight: 0,
      state: "connected",
      outbound: true, // a dangling connection is one the focus declares (target just doesn't resolve)
      inbound: false,
      alreadyLinked: true,
      dangling: true
    });
  }

  return { focus: focusPath, inner, outer: cands.filter((c) => c.state === "candidate") };
}

/**
 * Among a set of notes (the displayed neighbours), find pairs that directly link or connect
 * to each other — "how these notes connect among themselves." Sparse and meaningful (not a
 * hairball): only real note→note links/connections count, not shared facets. Undirected, deduped.
 */
export function neighborEdges(paths: string[], idx: FacetIndex): Array<[string, string]> {
  const byBase = new Map<string, string>(); // basename -> path, for the displayed set only
  for (const p of paths) {
    const r = idx.get(p);
    if (r) byBase.set(r.basename, p);
  }
  const edges: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const r = idx.get(p);
    if (!r) continue;
    for (const target of new Set([...r.linkPaths, ...r.connections].map(strip))) {
      const tp = byBase.get(target);
      if (!tp || tp === p) continue;
      const key = p < tp ? `${p}|${tp}` : `${tp}|${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([p, tp]);
    }
  }
  return edges;
}

/** rarity beats count: rarest shared facet first, then weighted sum, then name (stable). */
function byRarity(a: Candidate, b: Candidate): number {
  return a.rarestDf - b.rarestDf || b.weight - a.weight || a.basename.localeCompare(b.basename);
}

/** Reduce any link/connection token to a bare basename for comparison. */
function strip(s: string): string {
  return s
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    .split("#")[0]
    .split("/")
    .pop()!
    .replace(/\.md$/i, "")
    .trim();
}
