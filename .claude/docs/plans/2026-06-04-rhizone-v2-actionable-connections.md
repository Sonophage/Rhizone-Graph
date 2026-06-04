# Rhizone v2 — actionable connections

Follows the 2026-06-04 roundtable on the feature-complete galaxy view. Goal: make the rich
model legible and *actionable* — open/forge from any node, pull the keystone's unwritten doors
inward, and give connections a user-friendly, keyboard-reachable face.

## Decisions (locked with the user)
- **Plain click on a ring node → a native Obsidian `Menu`.** Summon becomes a menu item.
- Fast paths kept: **double-click = Summon**, **Enter = summon cursor**, **alt-click = forge**.
- All actions route through ONE dispatcher (`runAction(verb, target)`) shared by menu / panel /
  keyboard / alt-click.

## Interaction model
Menu contents by target kind:
- **Note:** Summon · Open · Open in new pane · Forge connection *(kin-of-keystone only)* · Reveal in Reticular
- **Ghost:** Summon (enter the unwritten door) · Create note *(forge-from-ghost)* · Forge into keystone *(if focused)*

## P0 — Ghosts join the inner ring on summon *(bug fix)*
Root cause: inner ring is built only from `relatedNotes()` (note paths); `layoutGhosts()` hard-codes
every ghost to `R_GHOST`. So a keystone's phantom facets can never reach the inner ring.
- `rhizoneView.ts` `layout()`: compute `ghostKin` = `noteFacets(ksNote)` ∩ ghost keys.
- New `placeGhost(key, p, state)` helper (mirrors `place()` for `_ghostEls`).
- Place note-kin + ghost-kin together around `R_IN` (one combined inner ring).
- `layoutGhosts(activeSet, innerGhosts)` skips the inner ghosts; the rest stay at `R_GHOST`.
- Phantom facets land in Da'ath (not drawn as tree Sephirot) → no duplication with the tree.
- The keystone→ghost dashed chord reattaches automatically (positions come from `_pos`).
- **Verify:** summon a note that wikilinks an unwritten target → ghost slides inward, named, tied.

## P1 — Node action menu
- `actionsFor(target): Action[]`, `runAction(verb, target)`, `openNodeMenu(target, evt)` (Obsidian `Menu`).
- Host add: `openNote(path, newLeaf?)`. (`forge`, `openInScope` exist.)
- alt-click → `runAction("forge")`; double-click → `runAction("summon")`.

## P2 — Connections panel (the user-friendly face)
- Slide-in column (mirrors Reticular's list-column). On summon, lists inner kin (notes + ghost-kin)
  with the **shared rare facet named** as the "why" + per-row buttons (Open / Forge / Create).
  Keyboard-navigable. Accessibility spine.
- Host change: `relatedNotes()` also returns `via: {key,label}` (rarest shared facet).

## P3 — Felt forge + ghost-forge
- Felt: `rg-graduating` settle animation on the kin before the rebuild; Notice with **Undo**.
- Host adds: `removeConnection(a,b)` (mirror `forge` in `connections.ts`); `createGhostNote(key)` →
  prefix-inferred filename, create empty, open, return path; "Create note" then forges keystone→new.

## Carried polish (opportunistic)
Hover hot-path (track previously-lit set, not clear-all ~340); default animations toggle from OS
`prefers-reduced-motion`; dismissable ring legend.

## Sequence
P0 → P1 → P2 → P3. Build + 55 engine tests stay green each step; add view unit tests for
`actionsFor`, `ghostKin`, and `relatedNotes.via`.
