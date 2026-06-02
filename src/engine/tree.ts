// Rhizone — the Ten Gateways (Etz Chaim). PURE (no Obsidian imports, erasable syntax only).
//
// The cold-open frontispiece: the whole vault compressed to ten luminous Sephirot. It is an
// emblem, not a master map — you enter a gateway and leave it behind for the perspectival
// rhizome. The structure carries meaning:
//   • altitude = rarity (Kether rarest/crown → Malkuth commonest/manifest ground)
//   • Middle Pillar = the rare BRIDGES (the connectors you traverse) + Malkuth (most-cited)
//   • Right / Left Pillars = the two largest co-occurrence COMMUNITIES
//   • Da'ath (the hidden gateway) = the phantom facets — what the vault gestures at, never wrote

import type { FacetIndex } from "./index.ts";
import {
  buildFacetGraph,
  detectCommunities,
  communities,
  bridgeScores,
  edgeBetween,
  rarityAltitude,
  type FacetNode,
  type FacetGraph
} from "./facetGraph.ts";

export type Pillar = "middle" | "right" | "left";
export type SephiraName =
  | "Kether" | "Chokmah" | "Binah" | "Chesed" | "Geburah"
  | "Tiphereth" | "Netzach" | "Hod" | "Yesod" | "Malkuth";
export type Role = "bridge" | "ground" | "community-a" | "community-b";

export interface SephiraSlot {
  name: SephiraName;
  pillar: Pillar;
  /** normalized canvas coords: x 0(left)→1(right), y 0(top/rare)→1(bottom/common) */
  x: number;
  y: number;
}

// Canonical Tree-of-Life geometry. y ascends with commonness so position ≈ rarity altitude.
export const SEPHIROT: SephiraSlot[] = [
  { name: "Kether", pillar: "middle", x: 0.5, y: 0.05 },
  { name: "Chokmah", pillar: "right", x: 0.75, y: 0.17 },
  { name: "Binah", pillar: "left", x: 0.25, y: 0.17 },
  { name: "Chesed", pillar: "right", x: 0.75, y: 0.4 },
  { name: "Geburah", pillar: "left", x: 0.25, y: 0.4 },
  { name: "Tiphereth", pillar: "middle", x: 0.5, y: 0.52 },
  { name: "Netzach", pillar: "right", x: 0.75, y: 0.72 },
  { name: "Hod", pillar: "left", x: 0.25, y: 0.72 },
  { name: "Yesod", pillar: "middle", x: 0.5, y: 0.84 },
  { name: "Malkuth", pillar: "middle", x: 0.5, y: 0.97 }
];
/** the hidden gateway, between the supernals and the heart — home of the phantom facets */
export const DAATH = { x: 0.5, y: 0.3 };

export interface Gateway extends SephiraSlot {
  facet: FacetNode | null;
  role: Role;
  /** rarity altitude of the assigned facet (0..1), independent of the slot's fixed y */
  altitude: number;
}

export interface TreePath {
  from: SephiraName;
  to: SephiraName;
  shared: number;
  affinity: number;
}

export interface Tree {
  gateways: Gateway[];
  /** phantom facets at Da'ath, by reach (df) desc */
  daath: FacetNode[];
  /** edges between gateways whose facets actually co-occur */
  paths: TreePath[];
  communityA: string | null;
  communityB: string | null;
}

/** Pick representatives spanning rare→common from a community: rarest, median, commonest. */
function spread(members: FacetNode[]): [FacetNode | null, FacetNode | null, FacetNode | null] {
  const sorted = [...members].sort((a, b) => a.df - b.df || a.key.localeCompare(b.key));
  if (sorted.length === 0) return [null, null, null];
  if (sorted.length === 1) return [sorted[0], null, null];
  if (sorted.length === 2) return [sorted[0], null, sorted[1]];
  return [sorted[0], sorted[Math.floor((sorted.length - 1) / 2)], sorted[sorted.length - 1]];
}

/**
 * Assign the whole vault to the Ten Gateways. PURE. Order of assignment guards against a facet
 * landing in two slots: ground (Malkuth) → bridges (middle) → the two community pillars.
 */
export function buildTree(idx: FacetIndex): Tree {
  return buildTreeFromGraph(buildFacetGraph(idx));
}

/** Assign an already-built facet graph to the Ten Gateways — lets callers pass a LOCAL subgraph. */
export function buildTreeFromGraph(g: FacetGraph): Tree {
  const labels = detectCommunities(g);
  const comms = communities(labels);
  const scores = bridgeScores(g, labels);

  const real = (n: FacetNode) => !n.phantom;
  const node = (key: string): FacetNode | undefined => g.nodes.get(key);
  const used = new Set<string>();
  const assign: Partial<Record<SephiraName, { facet: FacetNode | null; role: Role }>> = {};

  // ── Malkuth: the single most-cited (manifest) facet ──
  let ground: FacetNode | null = null;
  for (const n of g.nodes.values()) {
    if (!real(n)) continue;
    if (!ground || n.df > ground.df || (n.df === ground.df && n.key < ground.key)) ground = n;
  }
  if (ground) used.add(ground.key);
  assign.Malkuth = { facet: ground, role: "ground" };

  // ── Middle pillar bridges: Tiphereth = strongest, Kether = rarest, Yesod = next ──
  const bridges = [...g.nodes.values()]
    .filter((n) => real(n) && !used.has(n.key) && (scores.get(n.key) ?? 0) > 0)
    .sort((a, b) => (scores.get(b.key)! - scores.get(a.key)!) || a.df - b.df || a.key.localeCompare(b.key));
  const takeBridge = (sel: (rem: FacetNode[]) => FacetNode | undefined): FacetNode | null => {
    const rem = bridges.filter((n) => !used.has(n.key));
    const pick = sel(rem) ?? null;
    if (pick) used.add(pick.key);
    return pick;
  };
  const tiphereth = takeBridge((rem) => rem[0]); // strongest connector (the heart)
  const kether = takeBridge((rem) => [...rem].sort((a, b) => a.df - b.df || a.key.localeCompare(b.key))[0]); // rarest
  const yesod = takeBridge((rem) => rem[0]); // next strongest
  assign.Tiphereth = { facet: tiphereth, role: "bridge" };
  assign.Kether = { facet: kether, role: "bridge" };
  assign.Yesod = { facet: yesod, role: "bridge" };

  // ── Side pillars: the two largest real communities, three reps each (rare→common) ──
  const realComm = comms
    .map((c) => ({ label: c.label, members: c.members.map(node).filter((n): n is FacetNode => !!n && real(n) && !used.has(n.key)) }))
    .filter((c) => c.members.length > 0);
  const A = realComm[0] ?? null;
  const B = realComm[1] ?? null;

  const placeSide = (
    comm: { members: FacetNode[] } | null,
    role: Role,
    slots: [SephiraName, SephiraName, SephiraName] // [rare(top), median(mid), common(bottom)]
  ) => {
    const [rare, mid, common] = comm ? spread(comm.members.filter((n) => !used.has(n.key))) : [null, null, null];
    for (const f of [rare, mid, common]) if (f) used.add(f.key);
    assign[slots[0]] = { facet: rare, role };
    assign[slots[1]] = { facet: mid, role };
    assign[slots[2]] = { facet: common, role };
  };
  placeSide(A, "community-a", ["Chokmah", "Chesed", "Netzach"]);
  placeSide(B, "community-b", ["Binah", "Geburah", "Hod"]);

  // ── Compose gateways in canonical order ──
  const gateways: Gateway[] = SEPHIROT.map((s) => {
    const a = assign[s.name] ?? { facet: null, role: "bridge" as Role };
    return {
      ...s,
      facet: a.facet,
      role: a.role,
      altitude: a.facet ? rarityAltitude(a.facet.df, g.maxDf) : 1
    };
  });

  // ── Da'ath: phantom facets by reach ──
  const daath = [...g.nodes.values()]
    .filter((n) => n.phantom)
    .sort((a, b) => b.df - a.df || a.key.localeCompare(b.key))
    .slice(0, 12);

  // ── Paths: gateway pairs whose facets co-occur ──
  const paths = treePaths(g, gateways);

  return { gateways, daath, paths, communityA: A?.label ?? null, communityB: B?.label ?? null };
}

function treePaths(g: FacetGraph, gateways: Gateway[]): TreePath[] {
  const out: TreePath[] = [];
  for (let i = 0; i < gateways.length; i++) {
    for (let j = i + 1; j < gateways.length; j++) {
      const fa = gateways[i].facet;
      const fb = gateways[j].facet;
      if (!fa || !fb) continue;
      const e = edgeBetween(g, fa.key, fb.key);
      if (!e) continue;
      out.push({ from: gateways[i].name, to: gateways[j].name, shared: e.shared, affinity: e.affinity });
    }
  }
  return out.sort((a, b) => b.affinity - a.affinity);
}
