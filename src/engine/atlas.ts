import type { FacetIndex } from "./index.ts";
import { normalizeFacet } from "./alias.ts";

/** A co-occurring facet: appears together with the subject on `weight` notes. */
export interface CoFacet {
  key: string;
  label: string;
  weight: number;
}

/** One facet (genre / person / franchise — the things notes point AT) as the atlas sees it. */
export interface AtlasFacet {
  key: string;
  label: string;
  /** document frequency — how many notes cite this facet (its gravity) */
  df: number;
  /** no note resolves to this facet → it's a ghost note, vault-wide */
  phantom: boolean;
  /** paths of the notes that cite it */
  notes: string[];
  /** open-triad count: neighbour pairs this facet links that don't link each other (betweenness-lite) */
  bridgeScore: number;
  /** a highest-df facet — an inner-ring anchor */
  isHub: boolean;
  /** rare-but-load-bearing — high bridgeScore for its df */
  isBridge: boolean;
  /** the hub it co-occurs with most strongly (its angular home), or null if it stands alone */
  homeHub: string | null;
  /** co-occurring facets, strongest first */
  cooccur: CoFacet[];
}

/** An undirected co-occurrence edge: `weight` notes cite both `a` and `b`. */
export interface AtlasEdge {
  a: string;
  b: string;
  weight: number;
  /** touches a bridge facet — drawn highlighted */
  bridge: boolean;
}

export interface FacetAtlas {
  facets: AtlasFacet[]; // df desc
  edges: AtlasEdge[];
  hubs: string[]; // facet keys, df desc
  bridges: string[]; // facet keys, rare-bridge rank
  phantoms: string[]; // phantom facet keys, df desc
  noteCount: number;
  facetCount: number;
}

const HUB_COUNT = 12; // inner-ring anchors
const BRIDGE_COUNT = 14; // highlighted rare bridges
const NEIGHBOUR_CAP = 40; // bound triad math on mega-hubs
const TOP_EDGES_PER_FACET = 3; // keep the field sparse — strongest links only

/**
 * Build the whole-vault facet graph: facets ranked by df (hubs), co-occurrence edges,
 * vault-wide phantom facets, and a betweenness-lite "rare bridge" score. PURE.
 */
export function buildAtlas(idx: FacetIndex): FacetAtlas {
  // 1. enumerate facets + labels + which notes resolve to a real note
  const labels = new Map<string, string>();
  const existing = new Set<string>(); // facet keys that ARE a real note's basename
  for (const r of idx.all()) {
    existing.add(normalizeFacet(r.basename));
    for (const key of r.facetKeys) {
      if (key && !labels.has(key)) labels.set(key, r.facetLabels[key] ?? key);
    }
  }

  // 2. co-occurrence: every note's facets form a clique
  const cooc = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string): void => {
    let m = cooc.get(a);
    if (!m) cooc.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + 1);
  };
  for (const r of idx.all()) {
    const keys = [...new Set(r.facetKeys)].filter(Boolean);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        bump(keys[i], keys[j]);
        bump(keys[j], keys[i]);
      }
    }
  }

  // 3. df-ranked facet list + hub set
  const keysByDf = [...labels.keys()].sort((a, b) => idx.df(b) - idx.df(a) || a.localeCompare(b));
  const hubSet = new Set(keysByDf.slice(0, HUB_COUNT));

  // 4. per-facet: neighbours (strongest first), home hub, bridge score
  const neighboursOf = (key: string): CoFacet[] => {
    const m = cooc.get(key);
    if (!m) return [];
    return [...m.entries()]
      .map(([k, weight]) => ({ key: k, label: labels.get(k) ?? k, weight }))
      .sort((x, y) => y.weight - x.weight || x.label.localeCompare(y.label));
  };
  const bridgeScoreOf = (key: string, neigh: CoFacet[]): number => {
    const top = neigh.slice(0, NEIGHBOUR_CAP);
    let open = 0;
    for (let i = 0; i < top.length; i++) {
      const mi = cooc.get(top[i].key);
      for (let j = i + 1; j < top.length; j++) {
        if (!mi || !mi.has(top[j].key)) open++; // i and j meet only THROUGH this facet
      }
    }
    return open;
  };

  const facets: AtlasFacet[] = keysByDf.map((key) => {
    const neigh = neighboursOf(key);
    const homeHub = neigh.find((n) => hubSet.has(n.key))?.key ?? null;
    return {
      key,
      label: labels.get(key) ?? key,
      df: idx.df(key),
      phantom: !existing.has(key),
      notes: [...idx.notesWithFacet(key)].sort((a, b) => a.localeCompare(b)),
      bridgeScore: idx.df(key) >= 2 ? bridgeScoreOf(key, neigh) : 0,
      isHub: hubSet.has(key),
      isBridge: false, // set below
      homeHub,
      cooccur: neigh.slice(0, 12)
    };
  });

  // 5. rare bridges: high open-triad count for low df — "rarity beats count" at vault scale
  const bridges = [...facets]
    .filter((f) => f.bridgeScore > 0 && !f.isHub)
    .sort((a, b) => b.bridgeScore / Math.sqrt(b.df) - a.bridgeScore / Math.sqrt(a.df) || a.df - b.df)
    .slice(0, BRIDGE_COUNT);
  const bridgeSet = new Set(bridges.map((f) => f.key));
  for (const f of facets) if (bridgeSet.has(f.key)) f.isBridge = true;

  // 6. sparse edge set — each facet's strongest few links, deduped
  const seen = new Set<string>();
  const edges: AtlasEdge[] = [];
  for (const f of facets) {
    for (const n of f.cooccur.slice(0, TOP_EDGES_PER_FACET)) {
      const [a, b] = f.key < n.key ? [f.key, n.key] : [n.key, f.key];
      const id = `${a}|${b}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ a, b, weight: n.weight, bridge: bridgeSet.has(a) || bridgeSet.has(b) });
    }
  }

  return {
    facets,
    edges,
    hubs: keysByDf.slice(0, HUB_COUNT),
    bridges: bridges.map((f) => f.key),
    phantoms: facets.filter((f) => f.phantom).sort((a, b) => b.df - a.df).map((f) => f.key),
    noteCount: idx.size(),
    facetCount: facets.length
  };
}
