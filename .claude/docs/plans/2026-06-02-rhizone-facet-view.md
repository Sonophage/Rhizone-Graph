# Rhizone — the facet view (design spec)

> Status: **design only, not built.** Captured 2026-06-02. The shipping plugin currently
> contains only the **Reticular Graph** (local connection-web). This document specifies the
> *second* graph, "Rhizone," to be built in later sessions.

## Why two graphs

Born from the thesis in the vault note *"The Densest City In The World Had a Strange Secret"*
(Kowloon): **a map is a claim that there's one correct way to see a place; drawing the definitive
map freezes the territory and governs it instead of describing it.** Leave it rhizomatic — mental
map, not master plan.

- **Reticular Graph** = *the resident.* Local, per-note. The worn paths: what's already linked,
  what's one shared-hallway away. A familiarity engine. (Ships today.)
- **Rhizone** = *the tourist in your own vault.* Whole-vault facet view. Its job is **estrangement**:
  surface the adjacencies you'd never draw yourself — notes joined only by a single rare,
  happenstance facet. The stair welded between two buildings that share no street.

The old **Atlas** view (hub-and-spoke solar system) was retired: a hub map crowns high-frequency
facets as suns — it *is* a master plan, the thing the thesis rejects. Do **not** resurrect its
`atlas.ts` hub/df/betweenness model.

## Principles

- **Perspectival, never canonical.** No stored master layout. Renders *from a vantage* and
  re-lays-out on every jump — "a map from here," many maps, one per entry.
- **Global rarity as gravity.** A facet's rarity is a stable vault-wide fact (`1/df`). Rare shared
  facets **pull hard** — a single weird coincidence drags two strangers into the same room. Common
  shared facets exert almost no pull (a thoroughfare, ignored).
- **Altitude = rarity (a literal vertical axis).** Absolute, vault-wide: rare facets sit high,
  common facets sink to the floor. Only the vertical meaning is fixed; the neighborhood and
  horizontal spread re-seed. This is the Etz Chaim's emanation axis — Kether (rarest/source) →
  Malkuth (commonest/manifest).
- **The negative of Reticular.** Suppress the obvious — direct links, curated connections, fat
  common-facet co-citation (the resident's paths). Foreground only **rare-facet-only bridges**.

## Default look — the Ten Gateways (Etz Chaim)

Cold-open is NOT seeded from the active note (that's Reticular's role). It is a stable, iconic
frontispiece: the whole vault compressed to **ten luminous Sephirot** you enter and leave behind
on the first jump.

- **Middle Pillar** (Kether · Tiphereth · Yesod · Malkuth) = **bridge facets** by rarity. Kether =
  rarest bridge; Tiphereth = strongest connector (the heart); Yesod = a lower bridge; **Malkuth =
  the single most-cited facet** (the manifest ground).
- **Right Pillar** (Chokmah · Chesed · Netzach) = **Community A**, three facets rare→common.
- **Left Pillar** (Binah · Geburah · Hod) = **Community B**, three facets rare→common.
- **22 paths** between Sephirot that share notes; brightness ∝ rarity.
- **Da'ath** (hidden gateway) = **phantom facets** — wikilink targets with no note behind them.
- Click a gateway → enter the perspectival rhizome seeded from that facet.

## Navigation — doors, stairs, traversal

- **Hybrid bloom.** Facets are the mesh (corridors); a facet **blooms its notes inline** (doors) on
  expand, collapses to hide. Notes are latent, summoned.
- **Every note a door; every jump a stair.** Stand on a note → its *rare* facets are the lit stairs
  out (common ones stay dim/low) → a stair lands on another note sharing that rarity → step through
  → **re-seed**. Stair direction = rarity delta: up = rarer/stranger, down = commoner, horizontal =
  peers joined by a rare facet.

## Search — choosing a door

Search **filename + content**. Returns **three candidate doors (notes)** plus **how they connect to
each other, if at all** (a tiny preview-graph of the three). You pick which to enter. The one
teleport in a walk-only world; after landing, you climb by hand. Plus a **dice/"wander"** control:
drop me at a random rare door.

## Quick connections + the depletion mechanic

One-click **forge** from a stair (reuse `forge()` in `src/obsidian/connections.ts`). Because Rhizone
is Reticular's negative, **forging consumes its own content**: welding a rare coincidence into a real
`connections:` edge graduates that pair into a resident path — the stair **settles** (descends, dims)
and drains *out* of Rhizone into Reticular. The view **depletes as you colonize it**: tourist →
resident, one stair at a time.

## Animations (reuse the existing `animations` setting + OS reduce-motion gate)

- **Traversal = a real climb/descent** along the rarity axis (camera + nodes slide); the
  lightning-flash / path-of-return. Horizontal jumps glide sideways.
- **Bloom = doors unfolding** from a facet; collapse folds them back.
- **Gravity = spring-settle** with slight overshoot as rare pulls snap strangers into place.
- **Rare bridges glint** on hover; rarer = brighter riser.

## Engine reuse vs. new

- **Reuse (facet-model-neutral):** `FacetIndex` (`src/engine/index.ts`), `normalizeFacet`/`facetLabel`
  (`alias.ts`), `recordFromCache`/`buildRecords` (`adapter.ts`), `forge()` (`connections.ts`), the
  `animations`/phantom settings plumbing.
- **New PURE engine modules** (no Obsidian imports, mirroring the existing engine boundary):
  community detection (two largest communities for the pillars); bridge detection under the NEW
  model (rare facets joining separate communities — not atlas.ts's betweenness/df); gravity layout
  (rarity-weighted attraction) + the fixed rarity→altitude mapping; Tree assignment (facets → 10
  Sephirot positions).
- **New view:** `RhizoneFacetView` (SVG) + its own tests. Reserved view-type: `rhizone-graph` /
  `rhizone-facet`.

## Suggested build order

1. New engine modules + tests (community / bridge / gravity / tree-assignment) against the live vault.
2. The Ten Gateways default render.
3. Perspectival re-seed + hybrid bloom + traversal.
4. Search (3-doors) + quick-connect depletion.
5. Animations + Style Settings.

## Open questions

- Community-detection algorithm + behavior when the vault has 3+ strong clusters (overflow where?).
- Neighborhood horizon size (how many nodes per perspectival render before fade-out).
- Whether depleted (forged) pairs are hard-hidden or just sunk/greyed in Rhizone.
