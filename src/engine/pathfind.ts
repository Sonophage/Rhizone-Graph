// Rhizone — pathfinding through the space between notes. PURE (no Obsidian imports, erasable syntax).
//
// "How does A reach B?" — the soul of the tourist view. Notes are joined when they SHARE A FACET;
// a hop's cost is the rarity (df) of the rarest facet the two notes share, so the cheapest path
// prefers RARE, specific bridges (the stairs) over thoroughfare facets, and few hops. Common
// thoroughfare facets are skipped entirely — they connect everything to everything and make no
// meaningful stair. The result is a chain like Gnosticism →(Philip K. Dick)→ … →(Tyrell)→ Blade Runner.

import type { FacetIndex } from "./index.ts";
import { isContentTitle } from "./facetGraph.ts";

export interface PathHop {
  /** the rarest facet the two adjacent notes share — the stair you climb */
  via: string;
  /** document frequency of that facet (its rarity; lower = stranger) */
  df: number;
}

export interface NotePath {
  /** note paths, from → to (length = hops.length + 1) */
  notes: string[];
  hops: PathHop[];
}

/** Facets cited by more notes than this are thoroughfares, not stairs — never routed through. */
const DF_THOROUGHFARE = 60;
/** A small per-hop penalty so the route prefers fewer stairs when costs are otherwise close. */
const HOP_PENALTY = 4;

/**
 * Cheapest meaningful path between two notes over the co-citation graph. PURE.
 * `skip` excludes notes from being waypoints (e.g. Rhizone-hidden notes). Returns null if
 * unreachable within `maxHops` through rare-enough shared facets.
 */
export function findPath(
  idx: FacetIndex,
  from: string,
  to: string,
  opts: { maxHops?: number; skip?: (path: string) => boolean; avoid?: Set<string> } = {}
): NotePath | null {
  const maxHops = opts.maxHops ?? 8;
  const skip = opts.skip ?? (() => false);
  const avoid = opts.avoid;
  if (from === to) return { notes: [from], hops: [] };

  const dist = new Map<string, number>([[from, 0]]);
  const depth = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; via: string; df: number }>();
  const done = new Set<string>();
  const frontier = new Set<string>([from]);

  while (frontier.size) {
    let u: string | null = null;
    let best = Infinity;
    for (const n of frontier) {
      const d = dist.get(n)!;
      if (d < best) (best = d), (u = n);
    }
    if (u === null) break;
    frontier.delete(u);
    if (u === to) break;
    if (done.has(u)) continue;
    done.add(u);
    const du = depth.get(u)!;
    if (du >= maxHops) continue; // don't expand past the hop budget
    const rec = idx.get(u);
    if (!rec) continue;

    for (const key of new Set(rec.facetKeys)) {
      if (isContentTitle(key) || avoid?.has(key)) continue;
      const df = idx.df(key);
      if (df < 2 || df > DF_THOROUGHFARE) continue; // need ≥2 to join two notes; skip thoroughfares
      const edge = df + HOP_PENALTY;
      for (const v of idx.notesWithFacet(key)) {
        if (v === u || done.has(v) || skip(v)) continue;
        const cost = best + edge;
        if (cost < (dist.get(v) ?? Infinity)) {
          dist.set(v, cost);
          depth.set(v, du + 1);
          prev.set(v, { node: u, via: key, df });
          frontier.add(v);
        }
      }
    }
  }

  if (!prev.has(to)) return null;
  const notes = [to];
  const hops: PathHop[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return null;
    notes.unshift(p.node);
    hops.unshift({ via: p.via, df: p.df });
    cur = p.node;
  }
  return { notes, hops };
}
