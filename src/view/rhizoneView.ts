import { ItemView, type WorkspaceLeaf, type App } from "obsidian";
import { DAATH, type Tree, type Gateway } from "../engine/tree.ts";
import { neighborhood, rarityAltitude, type FacetGraph, type Neighbor } from "../engine/facetGraph.ts";

export const RHIZONE_FACET_VIEW_TYPE = "rhizone-facet";

const W = 1000;
const H = 1000;
const PADX = 120; // room for side-pillar labels
const PADY = 78;

/** What the Rhizone view needs from the plugin — kept narrow to avoid a circular import. */
export interface RhizoneHost {
  app: App;
  /** Whole-vault facet model as the Ten Gateways (Etz Chaim). */
  buildTree(): Tree;
  /** The whole-vault facet graph (for the perspectival rhizome). */
  facetGraph(): FacetGraph;
  /** Notes citing a facet — the doors that bloom from it. */
  notesForFacet(key: string): { path: string; basename: string }[];
  /** Run motion, overriding OS reduce-motion (persisted, shared with the Scope). */
  animations(): boolean;
}

const ROLE_CLASS: Record<Gateway["role"], string> = {
  bridge: "rg-gate-bridge",
  ground: "rg-gate-ground",
  "community-a": "rg-gate-a",
  "community-b": "rg-gate-b"
};

/** Functional captions — each slot announces its job. ▸ = right community, ◂ = left (per the header). */
const CAPTION: Record<string, string> = {
  Kether: "Rarest bridge",
  Tiphereth: "Keystone",
  Yesod: "Lesser bridge",
  Malkuth: "Common ground",
  Chokmah: "▸ rarest",
  Chesed: "▸ mid",
  Netzach: "▸ common",
  Binah: "◂ rarest",
  Geburah: "◂ mid",
  Hod: "◂ common"
};

/**
 * Rhizone — the tourist's view. PHASE 2: the cold-open frontispiece only — the whole vault
 * rendered as the Ten Gateways (Etz Chaim), altitude = rarity. Static for now; entering a
 * gateway into the perspectival rhizome comes in a later phase.
 */
export class RhizoneFacetView extends ItemView {
  private host: RhizoneHost;
  private seed: string | null = null; // null = Ten Gateways; a facet key = perspectival rhizome

  constructor(leaf: WorkspaceLeaf, host: RhizoneHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return RHIZONE_FACET_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Rhizone";
  }
  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("rhizone-facet");
    this.render();
  }

  /** Re-render (e.g. after the index changes). */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.toggleClass("rg-anim", this.host.animations());
    if (this.seed) {
      this.renderRhizome(root, this.seed);
      return;
    }
    this.renderGateways(root);
  }

  /** Enter a gateway → the perspectival rhizome seeded from that facet. */
  private enter(key: string): void {
    this.seed = key;
    this.render();
  }
  /** Leave the rhizome → back to the Ten Gateways frontispiece. */
  private exit(): void {
    this.seed = null;
    this.render();
  }

  private renderGateways(root: HTMLElement): void {
    let tree: Tree;
    try {
      tree = this.host.buildTree();
    } catch (e) {
      root.createDiv({ cls: "rg-error" }).setText("Rhizone render error:\n" + String((e as Error)?.stack ?? e));
      return;
    }

    // ── header bezel ──
    const bezel = root.createDiv({ cls: "rg-bezel" });
    bezel.createSpan({ cls: "rg-bezel-tag", text: "RHIZONE" });
    bezel.createSpan({ cls: "rg-bezel-title", text: "The Ten Gateways" });
    const meta = bezel.createSpan({ cls: "rg-tree-meta" });
    if (tree.communityA) meta.createSpan({ cls: "rg-tree-meta-r", text: `▸ ${labelOf(tree.communityA)}` });
    if (tree.communityB) meta.createSpan({ cls: "rg-tree-meta-l", text: `◂ ${labelOf(tree.communityB)}` });

    // ── stage / svg ──
    const stage = root.createDiv({ cls: "rg-tree-stage" });
    const svg = stage.createSvg("svg", {
      cls: "rg-tree",
      attr: { viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "The vault as the Ten Gateways" }
    });

    try {
      this.drawAxis(svg);
      this.drawPaths(svg, tree);
      this.drawDaath(svg, tree);
      for (const gw of tree.gateways) this.drawGateway(svg, gw);
    } catch (e) {
      root.createDiv({ cls: "rg-error" }).setText("Rhizone draw error:\n" + String((e as Error)?.stack ?? e));
      return;
    }

    // ── legend ──
    const legend = root.createDiv({ cls: "rg-tree-legend" });
    legendChip(legend, "rg-gate-bridge", "bridges — rare connectors");
    legendChip(legend, "rg-gate-a", tree.communityA ? `▸ ${labelOf(tree.communityA)}` : "▸ right community");
    legendChip(legend, "rg-gate-b", tree.communityB ? `◂ ${labelOf(tree.communityB)}` : "◂ left community");
    legendChip(legend, "rg-gate-ground", "Malkuth — common ground");
    legendChip(legend, "rg-gate-daath", "Da'ath — phantoms");
  }

  /** Faint rarity axis: rare at the crown, common at the floor. */
  private drawAxis(svg: SVGElement): void {
    const g = svg.createSvg("g", { cls: "rg-tree-axis" });
    for (const y of [0.05, 0.17, 0.4, 0.52, 0.72, 0.84, 0.97]) {
      const py = mapY(y);
      g.createSvg("line", { cls: "rg-tree-floor", attr: { x1: 40, y1: py, x2: W - 40, y2: py } });
    }
    g.createSvg("text", { cls: ["rg-tree-axis-label"], attr: { x: 30, y: mapY(0.05) - 6, "text-anchor": "start" } }).setText("RARE ↑");
    g.createSvg("text", { cls: ["rg-tree-axis-label"], attr: { x: 30, y: mapY(0.97) + 22, "text-anchor": "start" } }).setText("COMMON ↓");
  }

  private drawPaths(svg: SVGElement, tree: Tree): void {
    const pos = gatewayPositions(tree);
    const g = svg.createSvg("g", { cls: "rg-tree-paths" });
    for (const p of tree.paths) {
      const a = pos.get(p.from);
      const b = pos.get(p.to);
      if (!a || !b) continue;
      const line = g.createSvg("line", { cls: "rg-tree-path", attr: { x1: a.x, y1: a.y, x2: b.x, y2: b.y } });
      line.style.setProperty("--rg-path-strength", String(0.12 + p.affinity * 0.55));
    }
  }

  private drawDaath(svg: SVGElement, tree: Tree): void {
    const px = mapX(DAATH.x);
    const py = mapY(DAATH.y);
    const g = svg.createSvg("g", { cls: ["rg-tree-gate", "rg-gate-daath"] });
    g.createSvg("circle", { cls: ["rg-tree-dot"], attr: { cx: px, cy: py, r: 15 } });
    g.createSvg("text", { cls: ["rg-tree-sephira"], attr: { x: px, y: py - 24, "text-anchor": "middle" } }).setText("Phantoms");
    const n = tree.daath.length;
    g.createSvg("text", { cls: ["rg-tree-label"], attr: { x: px, y: py + 34, "text-anchor": "middle" } }).setText(n ? String(n) : "");
    if (n) g.setAttribute("aria-label", "Da'ath — " + tree.daath.slice(0, 6).map((f) => f.label).join(", "));
  }

  private drawGateway(svg: SVGElement, gw: Gateway): void {
    const px = mapX(gw.x);
    const py = mapY(gw.y);
    const g = svg.createSvg("g", { cls: ["rg-tree-gate", ROLE_CLASS[gw.role]] });
    g.createSvg("text", { cls: ["rg-tree-sephira"], attr: { x: px, y: py - radius(gw) - 10, "text-anchor": "middle" } }).setText(CAPTION[gw.name] ?? gw.name);

    if (!gw.facet) {
      g.addClass("rg-gate-empty");
      g.createSvg("circle", { cls: ["rg-tree-dot"], attr: { cx: px, cy: py, r: 11 } });
      return;
    }
    g.createSvg("circle", { cls: ["rg-tree-dot"], attr: { cx: px, cy: py, r: radius(gw) } });
    g.createSvg("text", { cls: ["rg-tree-label"], attr: { x: px, y: py + radius(gw) + 22, "text-anchor": "middle" } }).setText(
      trunc(displayLabel(gw.facet.label), 26)
    );
    g.createSvg("text", { cls: ["rg-tree-df"], attr: { x: px, y: py + radius(gw) + 40, "text-anchor": "middle" } }).setText(
      `df ${gw.facet.df}`
    );
    g.setAttribute("aria-label", `${gw.name}: ${gw.facet.label} (df ${gw.facet.df}, ${gw.role}) — click to enter`);
    g.addClass("rg-gate-enterable");
    const key = gw.facet.key;
    g.addEventListener("click", () => this.enter(key));
  }

  // ── the perspectival rhizome: seeded from one facet, gravity-placed, altitude = rarity ──
  private renderRhizome(root: HTMLElement, seedKey: string): void {
    let g: FacetGraph;
    try {
      g = this.host.facetGraph();
    } catch (e) {
      root.createDiv({ cls: "rg-error" }).setText("Rhizone render error:\n" + String((e as Error)?.stack ?? e));
      return;
    }
    const seedNode = g.nodes.get(seedKey);
    const nbrs = neighborhood(g, seedKey, 8);
    const maxDf = g.maxDf;
    const seedDf = seedNode?.df ?? 1;

    // ── header: back + seed name ──
    const bezel = root.createDiv({ cls: "rg-bezel" });
    const back = bezel.createSpan({ cls: "rg-rz-back", text: "‹ gateways", attr: { role: "button", "aria-label": "Back to the Ten Gateways" } });
    back.onClickEvent(() => this.exit());
    bezel.createSpan({ cls: "rg-bezel-tag", text: "RHIZONE" });
    bezel.createSpan({ cls: "rg-bezel-title", text: displayLabel(seedNode?.label ?? seedKey) });

    const stage = root.createDiv({ cls: "rg-tree-stage" });
    const svg = stage.createSvg("svg", {
      cls: ["rg-tree", "rg-rz"],
      attr: { viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": `Rhizome around ${seedKey}` }
    });
    this.drawAxis(svg);

    const sx = mapX(0.5);
    const sy = mapY(1 - rarityAltitude(seedDf, maxDf));
    // distinct columns flanking the seed (no centre column, so nothing sits on the seed),
    // strongest affinity nearest. Y = absolute rarity (rarer = higher); a parity stagger
    // offsets adjacent columns vertically so same-rarity neighbours never collide.
    const maxC = Math.max(1, Math.ceil(nbrs.length / 2));
    const placed = nbrs.map((nb, i) => {
      const c = i % 2 === 0 ? i / 2 + 1 : -((i + 1) / 2); // +1, -1, +2, -2, …
      const x = mapX(0.5 + (c / maxC) * 0.42);
      const y = mapY(1 - rarityAltitude(nb.df, maxDf)) + (Math.abs(c) % 2 === 1 ? 20 : 0);
      return { nb, x, y };
    });

    // edges seed → neighbour, brightness by gravity (affinity)
    const eg = svg.createSvg("g", { cls: "rg-tree-paths" });
    for (const p of placed) {
      const line = eg.createSvg("line", { cls: "rg-tree-path", attr: { x1: sx, y1: sy, x2: p.x, y2: p.y } });
      line.style.setProperty("--rg-path-strength", String(0.12 + p.nb.affinity * 0.7));
    }

    // doors: the seed's notes bloom in a tight ring around it
    this.drawDoors(svg, seedKey, sx, sy);

    // neighbour facets (the stairs) — click to climb / re-seed
    for (const p of placed) this.drawStair(svg, p.nb, p.x, p.y);

    // the seed at the centre
    const seedG = svg.createSvg("g", { cls: ["rg-rz-seed"] });
    seedG.createSvg("circle", { cls: ["rg-tree-dot"], attr: { cx: sx, cy: sy, r: 22 } });
    seedG.createSvg("text", { cls: ["rg-tree-label"], attr: { x: sx, y: sy + 42, "text-anchor": "middle" } }).setText(
      trunc(displayLabel(seedNode?.label ?? seedKey), 28)
    );
    seedG.createSvg("text", { cls: ["rg-tree-df"], attr: { x: sx, y: sy + 60, "text-anchor": "middle" } }).setText(`df ${seedDf}`);

    const legend = root.createDiv({ cls: "rg-tree-legend" });
    legend.createSpan({ text: "click a facet = climb a stair (re-seed) · click a door = open the note · ↑ rarer  ↓ commoner" });
  }

  /** A neighbour facet — a stair out of the seed; click to re-seed from it. */
  private drawStair(svg: SVGElement, nb: Neighbor, x: number, y: number): void {
    const g = svg.createSvg("g", {
      cls: ["rg-tree-gate", "rg-rz-stair"],
      attr: { role: "button", "aria-label": `${nb.label} (df ${nb.df}) — climb` }
    });
    const r = 8 + Math.min(12, Math.sqrt(nb.df) * 2.4);
    g.createSvg("circle", { cls: ["rg-tree-dot"], attr: { cx: x, cy: y, r } });
    g.createSvg("text", { cls: ["rg-tree-label"], attr: { x, y: y + r + 16, "text-anchor": "middle" } }).setText(
      trunc(displayLabel(nb.label), 20)
    );
    g.addEventListener("click", () => this.enter(nb.key));
  }

  /** Bloom the seed's notes as door-dots around it; click opens, hover previews. */
  private drawDoors(svg: SVGElement, seedKey: string, sx: number, sy: number): void {
    const notes = this.host.notesForFacet(seedKey).slice(0, 8);
    notes.forEach((n, i) => {
      const ang = -Math.PI / 2 + (i / Math.max(1, notes.length)) * Math.PI * 2;
      const dr = 46;
      const x = sx + Math.cos(ang) * dr;
      const y = sy + Math.sin(ang) * dr;
      const g = svg.createSvg("g", { cls: ["rg-rz-door"], attr: { "aria-label": n.basename } });
      g.createSvg("circle", { cls: ["rg-rz-door-dot"], attr: { cx: x, cy: y, r: 4 } });
      g.addEventListener("click", () => void this.host.app.workspace.openLinkText(n.basename, ""));
      g.addEventListener("mouseover", (ev) =>
        this.host.app.workspace.trigger("hover-link", {
          event: ev,
          source: "reticular-graph",
          hoverParent: this,
          targetEl: g,
          linktext: n.basename,
          sourcePath: ""
        })
      );
    });
  }
}

function radius(gw: Gateway): number {
  if (!gw.facet) return 11;
  return 12 + Math.min(16, Math.sqrt(gw.facet.df) * 3);
}

function gatewayPositions(tree: Tree): Map<string, { x: number; y: number }> {
  const m = new Map<string, { x: number; y: number }>();
  for (const gw of tree.gateways) if (gw.facet) m.set(gw.name, { x: mapX(gw.x), y: mapY(gw.y) });
  return m;
}

function mapX(x: number): number {
  return PADX + x * (W - 2 * PADX);
}
function mapY(y: number): number {
  return PADY + y * (H - 2 * PADY);
}

/** Drop one leading "Word - " organizational prefix for display (kept on disk, stripped here). */
function displayLabel(label: string): string {
  return label.replace(/^[A-Z][A-Za-z]+ - /, "");
}
function labelOf(communityKey: string): string {
  return trunc(displayLabel(communityKey), 22);
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function legendChip(parent: HTMLElement, cls: string, text: string): void {
  const chip = parent.createSpan({ cls: "rg-tree-legend-chip " + cls });
  chip.createSpan({ cls: "rg-tree-legend-swatch" });
  chip.createSpan({ text });
}
