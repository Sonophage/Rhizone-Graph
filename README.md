# Rhizone Graph

Two ways to see the same vault — built on the idea that a vault links notes to **facets**, not
to other notes, and that **a single map would freeze the territory**. So this plugin gives you
two complementary, deliberately partial views instead of one authoritative graph:

- **Reticular Graph** — *the resident.* A local, per-note connection-web (a CRT targeting scope):
  what the note you're on connects to, and what it *could* connect to, so you forge links by hand.
  The worn paths. **This ships today.**
- **Rhizone** — *the tourist in your own vault.* A whole-vault facet view whose job is
  estrangement: the adjacencies you'd never draw yourself — notes joined only by a single rare,
  happenstance facet. **Planned** (design in `.claude/docs/`); not built yet.

## The engine (read this — future-you will forget it)

This vault links notes to **facets**, not to other notes. Most `[[wikilinks]]` point at genres,
people, franchises, and projects (`[[Science Fiction]]`, `[[Philip K. Dick]]`, `[[Vlad]]`) — often
to notes that don't even exist. That's a faceted tag system in wikilink syntax.

So the engine is **co-citation over shared facets**: two notes are related when they cite the same
facets — *even phantom (uncreated) ones*. Candidates are ranked **rarity beats count**: the rarest
shared facet wins (lowest document-frequency), with `Σ 1/df` as the tiebreak. Sharing
`[[Philip K. Dick]]` (rare) means far more than sharing `[[Religion]]` (common). No embeddings, no
network — pure structure, so it stays light.

---

## Reticular Graph — the local connection-web (shipping)

Open it on a note and it shows, as a CRT targeting scope, that note's neighborhood — and you
traverse it. It is **not** a global graph; it shows one note at a time.

### Three layers, three states

| State | Source | In the scope |
|---|---|---|
| **Connected** `●` | the `connections:` frontmatter property | inner ring, solid |
| **Mentioned** `○` | an inline `[[link]]` only | inner ring, dim/dashed |
| **Candidate** `◇` | co-citation only (no link yet) | outer ring, accent, pulsing |
| **Dangling** `⚠` | a connection whose target note is gone | flagged, never auto-pruned |

`connections:` is the curated note↔note web. It's grown **by hand** — forging a candidate writes the
link into both notes' frontmatter (bidirectional, idempotent, always via `processFrontMatter`).

### The Scope

Concentric range-rings around a `⊕` reticle. Inner ring = `DIRECT` (links + connections), outer =
`CO-CITATION` candidates, placed **rarest-first from 12 o'clock, clockwise** (best candidate due
north). Hover/focus a contact to see *why* it's there (its shared facets, rarest-first).

**Keyboard:** `Tab` cycle contacts · `Enter` traverse · `F` designate (forge) · `Esc` back.

**Appearance** follows your theme accent by default; the **Style Settings** panel adds a phosphor
override (amber/green) and sweep/scanline intensity sliders. Honors `prefers-reduced-motion`.

---

## Rhizone — the facet view (planned)

The inverse of Reticular. Where Reticular shows the resident's worn paths, Rhizone makes you a
**tourist**: it surfaces only the connections you'd *never* draw — strangers joined by a single rare
facet. Sketch of the design (full spec in `.claude/docs/`):

- **Perspectival, never canonical** — renders *from* a vantage and re-lays-out on every jump. Many
  maps, one per entry; no stored master map.
- **Global rarity as gravity** — a rare shared facet *pulls hard*, dragging two strangers together;
  common facets exert almost no pull.
- **Altitude = rarity** — rare facets sit high, common facets sink to the floor (the Etz Chaim's
  emanation axis: Kether → Malkuth).
- **Default look: the Ten Gateways** — the whole vault compressed to ten Sephirot; side pillars =
  the two largest co-occurrence communities, middle pillar = the rare bridges between them.
- **Doors & stairs** — every note a door; every jump a rare-facet stair. Forging a connection
  *graduates* a pair into Reticular — so the tourist view **depletes as you colonize it**.

## Non-goals

- Reticular is never a whole-vault graph (that's Rhizone's job).
- No embeddings, ML, or network calls.
- No auto-population of `connections` — it is curated; the plugin only writes it on an explicit forge.
- No file rewrites for matching — the `Concept - ` prefix alias-strip is internal only.

## Build & install

```sh
npm install
npm run build          # tsc -noEmit + esbuild -> main.js
npm test               # node --test (engine golden + idempotency gates)
```

Install by symlinking this folder into your vault:
`<vault>/.obsidian/plugins/rhizone-graph -> this repo`, then enable **Rhizone Graph** in
Community Plugins. Open any note and run **“Open in Reticular Graph”** (command, ribbon, or the
file-menu).

## Architecture

- `src/engine/` — **pure**, zero Obsidian imports (inverted index, co-citation, rarity ranking,
  alias-strip, ring layout). Unit-tested with Node's built-in runner.
- `src/obsidian/` — thin adapter: `metadataCache → records`, and all `connections` writes via
  `processFrontMatter`.
- `src/view/` — the SVG Scope, traversal/keyboard, preview, dangling remediation.

MIT · Sonophage.
