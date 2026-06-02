// Rhizone Graph — engine types. PURE: no Obsidian imports, erasable syntax only
// (string unions instead of enums) so Node can type-strip these in tests.

export type NodeState = "connected" | "mentioned" | "candidate";

/** One note as the engine sees it. No Obsidian types. */
export interface NoteRecord {
  /** vault-relative path, e.g. "Concept - The Demiurge.md" */
  path: string;
  /** "Concept - The Demiurge" */
  basename: string;
  /** normalized facet keys (alias-stripped, attachments removed) */
  facetKeys: string[];
  /** normalized key -> first-seen display label */
  facetLabels: Record<string, string>;
  /** resolved note→note link targets (basenames) — feeds the "mentioned" state */
  linkPaths: string[];
  /** basenames from the frontmatter `connections` property */
  connections: string[];
}

export interface SharedFacet {
  key: string;
  label: string;
  /** document frequency: number of distinct notes carrying this facet */
  df: number;
}

export interface Candidate {
  path: string;
  basename: string;
  /** shared facets, rarest-first */
  shared: SharedFacet[];
  /** df of the rarest shared facet (the primary sort key) */
  rarestDf: number;
  /** Σ 1/df over shared facets (the tiebreak) */
  weight: number;
  state: NodeState;
  /** focus → this note: the focus declares the link/connection (places it in the OUTBOUND zone) */
  outbound: boolean;
  /** this note → focus: a backlink, the other note declares the relationship (INBOUND zone) */
  inbound: boolean;
  /** a direct link or connection already exists in either direction */
  alreadyLinked: boolean;
  /** a curated connection whose target note no longer exists (flagged, never auto-pruned) */
  dangling?: boolean;
}

export interface LocalWeb {
  focus: string;
  /** direct links + connections (state connected | mentioned), rarity-ranked */
  inner: Candidate[];
  /** co-citation candidates (state candidate), rarity-ranked */
  outer: Candidate[];
}
