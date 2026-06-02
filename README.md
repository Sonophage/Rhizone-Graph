# Rhizone Graph

A local **connection-web** for Obsidian. Open it on a note and it shows, as a CRT targeting
scope, what that note connects to — and what it *could* connect to — so you can forge links by hand.

It is **not** a global graph. It shows one note's neighborhood at a time, and you traverse it.

## The idea (read this — future-you will forget it)

This vault links notes to **facets**, not to other notes. Most `[[wikilinks]]` point at genres,
people, franchises, and projects (`[[Science Fiction]]`, `[[Philip K. Dick]]`, `[[Vlad]]`) — often
to notes that don't even exist. That's a faceted tag system in wikilink syntax.

So the engine is **co-citation over shared facets**: two notes are related when they cite the same
facets — *even phantom (uncreated) ones*. Candidates are ranked **rarity beats count**: the rarest
shared facet wins (lowest document-frequency), with `Σ 1/df` as the tiebreak. Sharing
`[[Philip K. Dick]]` (rare) means far more than sharing `[[Religion]]` (common). No embeddings, no
network — pure structure, so it stays light.

## Three layers, three states

| State | Source | In the scope |
|---|---|---|
| **Connected** `●` | the `connections:` frontmatter property | inner ring, solid |
| **Mentioned** `○` | an inline `[[link]]` only | inner ring, dim/dashed |
| **Candidate** `◇` | co-citation only (no link yet) | outer ring, accent, pulsing |
| **Dangling** `⚠` | a connection whose target note is gone | flagged, never auto-pruned |

`connections:` is the curated note↔note web. It's grown **by hand** — forging a candidate writes the
link into both notes' frontmatter (bidirectional, idempotent, always via `processFrontMatter`).

## The Scope

Concentric range-rings around a `⊕` reticle. Inner ring = `DIRECT` (links + connections), outer =
`CO-CITATION` candidates, placed **rarest-first from 12 o'clock, clockwise** (best candidate due
north). Hover/focus a contact to see *why* it's there (its shared facets, rarest-first).

**Keyboard:** `Tab` cycle contacts · `Enter` traverse · `F` designate (forge) · `Esc` back.

**Appearance** follows your theme accent by default; the **Style Settings** panel adds a phosphor
override (amber/green) and sweep/scanline intensity sliders. Honors `prefers-reduced-motion`.

## Non-goals

- No global/whole-vault graph.
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
Community Plugins. Open any note and run **“Open in Rhizone Graph”** (command, ribbon, or the
file-menu).

## Architecture

- `src/engine/` — **pure**, zero Obsidian imports (inverted index, co-citation, rarity ranking,
  alias-strip, ring layout). Unit-tested with Node's built-in runner.
- `src/obsidian/` — thin adapter: `metadataCache → records`, and all `connections` writes via
  `processFrontMatter`.
- `src/view/` — the SVG Scope, traversal/keyboard, preview, dangling remediation.

MIT · Sonophage.
