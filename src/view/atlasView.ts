import { ItemView, type WorkspaceLeaf, type TFile, type App } from "obsidian";
import type { AtlasFacet, FacetAtlas } from "../engine/atlas.ts";

export const RHIZONE_ATLAS_VIEW_TYPE = "rhizone-graph-atlas";

const VIEW = 1000; // square viewBox
const R_SUN = 330; // overview: each hub-sun sits this far from the VAULT core
const ORBIT = 78; // overview: a sun's companions orbit at this radius
const ZOOM_ORBIT = 300; // focused system: the companion orbit fills the canvas
const OVERVIEW_COMPANIONS = 6; // companions shown per sun in the overview (keeps each orbit clean)
const ZOOM_COMPANIONS = 16; // companions shown when a single system is focused

/** What the Atlas needs from the plugin. */
export interface AtlasHost {
  app: App;
  fileForPath(path: string): TFile | null;
  buildAtlas(): FacetAtlas;
  /** Open a note in the local Scope (revealing/creating that view). */
  openInScope(path: string): void;
  animations(): boolean;
}

interface Placed {
  f: AtlasFacet;
  x: number;
  y: number;
  r: number; // disc radius
  /** what this body orbits (its sun, or the core) — for the spoke + label direction. null = centre */
  px: number | null;
  py: number | null;
}

/**
 * The Facet Atlas — the whole-vault counterpart to the Scope. Stars are FACETS, not notes:
 * hubs (high df) anchor the inner ring, satellites fan into their hub's sector, the rarest and
 * the phantom (uncreated) facets drift to the rim. Lines are co-occurrence; rare BRIDGES glow.
 * Click a facet → its notes; click a note → open it in the Scope.
 */
export class RhizoneAtlasView extends ItemView {
  private host: AtlasHost;
  private atlas: FacetAtlas | null = null;
  private placed = new Map<string, Placed>();
  private adj = new Map<string, Set<string>>(); // facet key -> neighbour keys (from edges)
  private selected = "";
  private focusedHub = ""; // "" = overview (all systems); else the zoomed-in system's hub key
  private minDf = 1;
  private showPhantoms = true;
  private bridgesOnly = false;
  private _svg: SVGSVGElement | null = null;
  private _detail: HTMLElement | null = null;
  private nodeEls = new Map<string, SVGElement>();
  private edgeEls: Array<{ a: string; b: string; els: SVGElement[] }> = [];

  constructor(leaf: WorkspaceLeaf, host: AtlasHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return RHIZONE_ATLAS_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Facet Atlas";
  }
  getIcon(): string {
    return "orbit";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("rhizone-atlas");
    this.render();
  }

  /** External refresh (index changed). */
  refresh(): void {
    if (this.contentEl.isShown()) this.render();
  }

  // ── render ─────────────────────────────────────────────────────────────────
  private render(): void {
    const root = this.contentEl;
    root.empty();
    this.atlas = this.host.buildAtlas();

    const stage = root.createDiv({ cls: "rg-atlas-stage" });
    const graphCol = stage.createDiv({ cls: "rg-graph rg-atlas-graph" });
    if (this.host.animations()) graphCol.addClass("rg-anim"); // drives the breathing core glow

    // bezel header — same targeting-reticle chrome as the Scope
    const bezel = graphCol.createDiv({ cls: "rg-bezel rg-atlas-bezel" });
    bezel.createSpan({ cls: "rg-bezel-tag", text: "RHIZONE" });
    const focusedFacet = this.focusedHub ? this.atlas.facets.find((f) => f.key === this.focusedHub) : null;
    if (focusedFacet) {
      const back = bezel.createSpan({ cls: "rg-atlas-systems-back", attr: { role: "button" } });
      back.setText("‹ all systems");
      back.onClickEvent(() => this.unfocus());
      bezel.createSpan({ cls: "rg-bezel-title", text: focusedFacet.label });
    } else {
      bezel.createSpan({ cls: "rg-bezel-title", text: "FACET ATLAS" });
    }
    bezel.createSpan({
      cls: "rg-bezel-meta",
      text: `${this.atlas.facetCount} FACETS · ${this.atlas.noteCount} NOTES`
    });

    const galaxyCls = ["rg-galaxy", "rg-atlas-galaxy"];
    if (this.host.animations()) galaxyCls.push("rg-anim");
    const svg = graphCol.createSvg("svg", {
      cls: galaxyCls,
      attr: { viewBox: `0 0 ${VIEW} ${VIEW}`, role: "group", "aria-label": "Facet atlas of the vault" }
    });
    this._svg = svg as SVGSVGElement;
    const cx = VIEW / 2;
    const cy = VIEW / 2;
    svg.style.setProperty("--rg-origin", `${cx}px ${cy}px`);
    svg.addEventListener("click", () => this.onBackground()); // empty space: zoom out, else clear

    this.layout(cx, cy);
    this.draw(svg, cx, cy);

    // legend + controls under the constellation
    this.drawLegend(graphCol);

    // detail / summary panel on the right
    this._detail = stage.createDiv({ cls: "rg-atlas-detail" });
    this.renderDetail();
  }

  // ── solar-system layout ─────────────────────────────────────────────────────
  // Overview: hub-suns ring the VAULT core, each with a tight orbit of its strongest companions.
  // Focused: one system fills the canvas, its companions on a big orbit. Deterministic, no physics.
  private layout(cx: number, cy: number): void {
    this.placed.clear();
    this.adj.clear();
    const atlas = this.atlas!;

    const visible = atlas.facets.filter((f) => this.isVisible(f));
    const hubs = visible.filter((f) => f.isHub);

    const discFor = (f: AtlasFacet, sun = false): number => {
      const base = 3.5 + Math.sqrt(f.df) * 1.7;
      return Math.max(3.5, Math.min(sun ? 18 : 11, base));
    };
    const place = (f: AtlasFacet, x: number, y: number, px: number | null, py: number | null, sun = false): void => {
      this.placed.set(f.key, { f, x, y, r: discFor(f, sun), px, py });
    };

    // companions grouped under their home hub
    const sectors = new Map<string, AtlasFacet[]>();
    for (const f of visible) {
      if (f.isHub || !f.homeHub) continue;
      const arr = sectors.get(f.homeHub) ?? [];
      arr.push(f);
      sectors.set(f.homeHub, arr);
    }
    const hubWeight = (f: AtlasFacet, hubKey: string): number => f.cooccur.find((c) => c.key === hubKey)?.weight ?? 0;
    const bridgeFirst = (a: AtlasFacet, b: AtlasFacet): number => (b.isBridge ? 1 : 0) - (a.isBridge ? 1 : 0);
    const companionsOf = (hubKey: string, cap: number): AtlasFacet[] =>
      (sectors.get(hubKey) ?? [])
        .sort((a, b) => bridgeFirst(a, b) || hubWeight(b, hubKey) - hubWeight(a, hubKey) || b.df - a.df || a.label.localeCompare(b.label))
        .slice(0, cap);
    const orbit = (sx: number, sy: number, members: AtlasFacet[], r: number): void => {
      members.forEach((m, i) => {
        const a = -Math.PI / 2 + (i / Math.max(1, members.length)) * Math.PI * 2;
        place(m, sx + Math.cos(a) * r, sy + Math.sin(a) * r, sx, sy);
      });
    };

    const focused = this.focusedHub ? atlas.facets.find((f) => f.key === this.focusedHub && f.isHub) : null;
    if (focused) {
      // one system, centred and blown up
      place(focused, cx, cy, null, null, true);
      orbit(cx, cy, companionsOf(focused.key, ZOOM_COMPANIONS), ZOOM_ORBIT);
    } else {
      // all systems: suns ring the core, each with its own little orbit
      hubs.forEach((h, i) => {
        const a = -Math.PI / 2 + (i / Math.max(1, hubs.length)) * Math.PI * 2;
        const sx = cx + Math.cos(a) * R_SUN;
        const sy = cy + Math.sin(a) * R_SUN;
        place(h, sx, sy, cx, cy, true);
        orbit(sx, sy, companionsOf(h.key, OVERVIEW_COMPANIONS), ORBIT);
      });
    }

    // adjacency from visible edges (for the hover spotlight)
    for (const e of atlas.edges) {
      if (!this.placed.has(e.a) || !this.placed.has(e.b)) continue;
      (this.adj.get(e.a) ?? this.adj.set(e.a, new Set()).get(e.a)!).add(e.b);
      (this.adj.get(e.b) ?? this.adj.set(e.b, new Set()).get(e.b)!).add(e.a);
    }
  }

  private isVisible(f: AtlasFacet): boolean {
    if (f.df < this.minDf && !f.isHub) return false;
    if (f.phantom && !this.showPhantoms) return false;
    if (this.bridgesOnly && !f.isBridge && !f.isHub) return false;
    return true;
  }

  // ── draw ─────────────────────────────────────────────────────────────────────
  private draw(svg: SVGElement, cx: number, cy: number): void {
    this.nodeEls.clear();
    this.edgeEls = [];
    const atlas = this.atlas!;

    const orbitR = this.focusedHub ? ZOOM_ORBIT : ORBIT;

    // faint orbit ring around each sun (a hub that has a parent = core, or the focused centre)
    for (const p of this.placed.values()) {
      if (p.f.isHub) svg.createSvg("circle", { cls: "rg-atlas-orbit", attr: { cx: p.x, cy: p.y, r: orbitR } });
    }

    // spokes: each body → what it orbits (core→sun, sun→companion)
    for (const p of this.placed.values()) {
      if (p.px === null || p.py === null) continue;
      this.edgeEls.push({
        a: p.f.key,
        b: "",
        els: [svg.createSvg("line", { cls: "rg-atlas-spoke", attr: { x1: p.px, y1: p.py, x2: p.x, y2: p.y } })]
      });
    }

    // VAULT core — overview only (in a focused system the centre IS the sun)
    if (!this.focusedHub) {
      svg.createSvg("circle", { cls: "rg-core-disc", attr: { cx, cy, r: 40 } });
      svg.createSvg("text", { cls: "rg-atlas-core-label", attr: { x: cx, y: cy - 3, "text-anchor": "middle" } }).setText("VAULT");
      svg
        .createSvg("text", { cls: "rg-atlas-core-sub", attr: { x: cx, y: cy + 13, "text-anchor": "middle" } })
        .setText(`${atlas.facetCount} facets`);
    }

    // nodes on top
    for (const p of this.placed.values()) this.drawFacet(svg, p);
  }

  private drawFacet(svg: SVGElement, p: Placed): void {
    const f = p.f;
    const cls = ["rg-star", "rg-atlas-facet"];
    if (f.isHub) cls.push("rg-hub");
    if (f.isBridge) cls.push("rg-bridge");
    if (f.phantom) cls.push("rg-phantom-facet");
    if (f.key === this.selected) cls.push("rg-sel");
    const g = svg.createSvg("g", {
      cls,
      attr: { "data-key": f.key, tabindex: "0", role: "button", "aria-label": ariaFor(f) }
    });
    g.createSvg("circle", { cls: "rg-hit", attr: { cx: p.x, cy: p.y, r: Math.max(16, p.r + 8) } });

    // hubs always read as anchor discs even when phantom; only non-hub ghosts get the triangle
    if (f.phantom && !f.isHub) {
      g.createSvg("path", { cls: "rg-atlas-dot", attr: { d: triangle(p.x, p.y, p.r + 1) } });
    } else {
      g.createSvg("circle", { cls: "rg-atlas-dot", attr: { cx: p.x, cy: p.y, r: p.r } });
    }
    if (f.isBridge) g.createSvg("circle", { cls: "rg-bridge-halo", attr: { cx: p.x, cy: p.y, r: p.r + 5 } });

    // label points outward from whatever this body orbits (its sun / the core)
    if (p.px === null || p.py === null) {
      // a centred sun (focused system) — sit the label just below it
      g.createSvg("text", {
        cls: ["rg-star-label", "rg-atlas-label"],
        attr: { x: p.x, y: p.y + p.r + 18, "text-anchor": "middle" }
      }).setText(clip(f.label, 24));
    } else {
      const ang = Math.atan2(p.y - p.py, p.x - p.px);
      const ox = Math.cos(ang);
      const oy = Math.sin(ang);
      const anchor = ox > 0.3 ? "start" : ox < -0.3 ? "end" : "middle";
      g.createSvg("text", {
        cls: ["rg-star-label", "rg-atlas-label"],
        attr: { x: p.x + ox * (p.r + 6), y: p.y + oy * (p.r + 6) + 4, "text-anchor": anchor }
      }).setText(clip(f.label, 22));
    }

    const activate = (): void => {
      if (f.isHub) this.focusHub(f.key); // a sun → zoom into its system
      else this.select(f.key); // a companion → inspect it
    };
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      activate();
    });
    g.addEventListener("pointerenter", () => this.spotlight(f.key));
    g.addEventListener("pointerleave", () => this.spotlight(this.selected));
    g.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activate();
      }
    });
  }

  /** Dim everything except `key` and its neighbours; "" lifts the spotlight. */
  private spotlight(key: string): void {
    const svg = this._svg;
    if (!svg) return;
    if (!key) {
      svg.removeClass("rg-spotlight");
      this.nodeEls.forEach((el) => el.removeClass("rg-on"));
      this.edgeEls.forEach((e) => e.els.forEach((el) => el.removeClass("rg-lit")));
      return;
    }
    const lit = new Set<string>([key, ...(this.adj.get(key) ?? [])]);
    svg.addClass("rg-spotlight");
    for (const [k, el] of this.nodeEls) el.toggleClass("rg-on", lit.has(k));
    for (const e of this.edgeEls) {
      const on = e.a === key || e.b === key;
      e.els.forEach((el) => el.toggleClass("rg-lit", on));
    }
  }

  private select(key: string): void {
    this.selected = key;
    // cheap re-decorate: toggle selection class + spotlight without a full rebuild
    for (const [k, el] of this.nodeEls) el.toggleClass("rg-sel", k === key);
    this.spotlight(key);
    this.renderDetail();
  }

  /** Zoom into a hub's system (or back out if it's already focused). Re-renders (layout changes). */
  private focusHub(key: string): void {
    if (this.focusedHub === key) {
      this.unfocus();
      return;
    }
    this.focusedHub = key;
    this.selected = key;
    this.render();
  }

  private unfocus(): void {
    this.focusedHub = "";
    this.selected = "";
    this.render();
  }

  /** Click on empty space: zoom out if focused, else just clear the selection. */
  private onBackground(): void {
    if (this.focusedHub) this.unfocus();
    else this.select("");
  }

  // collected during draw so spotlight/select can reach the groups
  // (populated lazily here because drawFacet runs before nodeEls is read)
  private collectNodes(): void {
    if (!this._svg) return;
    this.nodeEls.clear();
    this._svg.querySelectorAll<SVGElement>(".rg-atlas-facet").forEach((el) => {
      const k = el.getAttribute("data-key");
      if (k) this.nodeEls.set(k, el);
    });
  }

  // ── legend / controls ────────────────────────────────────────────────────────
  private drawLegend(col: HTMLElement): void {
    const bar = col.createDiv({ cls: "rg-atlas-controls" });

    const phantom = bar.createSpan({
      cls: "rg-legend-item rg-ghost" + (this.showPhantoms ? "" : " is-hidden"),
      attr: { role: "button" }
    });
    phantom.createSpan({ cls: "rg-glyph", text: "▲" });
    phantom.createSpan({ text: " ghost facets" });
    phantom.onClickEvent(() => {
      this.showPhantoms = !this.showPhantoms;
      this.render();
    });

    const bridges = bar.createSpan({
      cls: "rg-legend-item rg-bridge-legend" + (this.bridgesOnly ? " is-active" : ""),
      attr: { role: "button" }
    });
    bridges.createSpan({ cls: "rg-glyph", text: "◆" });
    bridges.createSpan({ text: this.bridgesOnly ? " bridges only" : " bridges" });
    bridges.onClickEvent(() => {
      this.bridgesOnly = !this.bridgesOnly;
      this.render();
    });

    // df-min slider — thin the field
    const slider = bar.createSpan({ cls: "rg-atlas-slider" });
    slider.createSpan({ cls: "rg-atlas-slider-label", text: `df ≥ ${this.minDf}` });
    const input = slider.createEl("input", {
      attr: { type: "range", min: "1", max: "10", value: String(this.minDf) }
    });
    input.addEventListener("input", () => {
      this.minDf = Number(input.value);
      this.render();
    });
  }

  // ── detail / summary panel ────────────────────────────────────────────────────
  private renderDetail(): void {
    const el = this._detail;
    if (!el) return;
    el.empty();
    // collect node refs now that the SVG is in the DOM
    this.collectNodes();
    if (this.selected) {
      for (const [k, n] of this.nodeEls) n.toggleClass("rg-sel", k === this.selected);
      this.spotlight(this.selected);
    }

    const atlas = this.atlas!;
    const sel = this.selected ? atlas.facets.find((f) => f.key === this.selected) : null;
    if (sel) {
      this.renderFacetDetail(el, sel);
    } else {
      this.renderSummary(el, atlas);
    }
  }

  private renderSummary(el: HTMLElement, atlas: FacetAtlas): void {
    const head = el.createDiv({ cls: "rg-atlas-head" });
    head.createSpan({ cls: "rg-atlas-title", text: "REGISTER" });
    head.createDiv({ cls: "rg-atlas-meta", text: "select a facet on the constellation, or a chip below" });

    this.chipSection(el, "HUBS", "the gravity wells — what the vault is most about", atlas.hubs, "rg-hub");
    this.chipSection(el, "RARE BRIDGES", "thin facets that hold separate clusters together", atlas.bridges, "rg-bridge");
    this.chipSection(el, "GHOST FACETS", "everything points here, but no note exists yet", atlas.phantoms.slice(0, 18), "rg-phantom-facet");
  }

  private chipSection(el: HTMLElement, title: string, sub: string, keys: string[], cls: string): void {
    const sec = el.createDiv({ cls: "rg-atlas-section" });
    sec.createDiv({ cls: "rg-atlas-section-title", text: `${title} (${keys.length})` });
    sec.createDiv({ cls: "rg-atlas-section-sub", text: sub });
    if (!keys.length) {
      sec.createDiv({ cls: "rg-box-empty", text: "—" });
      return;
    }
    const wrap = sec.createDiv({ cls: "rg-atlas-chips" });
    const byKey = new Map(this.atlas!.facets.map((f) => [f.key, f]));
    for (const k of keys) {
      const f = byKey.get(k);
      if (!f) continue;
      const chip = wrap.createSpan({ cls: `rg-atlas-chip ${cls}`, attr: { role: "button" } });
      chip.createSpan({ text: f.label });
      chip.createSpan({ cls: "rg-atlas-chip-df", text: String(f.df) });
      chip.onClickEvent(() => this.select(k));
    }
  }

  private renderFacetDetail(el: HTMLElement, f: AtlasFacet): void {
    const back = el.createDiv({ cls: "rg-atlas-back", attr: { role: "button" } });
    back.setText("‹ all facets");
    back.onClickEvent(() => this.select(""));

    const head = el.createDiv({ cls: "rg-atlas-head" });
    head.createSpan({ cls: "rg-atlas-title", text: f.label });
    const badges = head.createDiv({ cls: "rg-atlas-badges" });
    if (f.isHub) badges.createSpan({ cls: "rg-atlas-badge rg-hub", text: "HUB" });
    if (f.isBridge) badges.createSpan({ cls: "rg-atlas-badge rg-bridge", text: "BRIDGE" });
    if (f.phantom) badges.createSpan({ cls: "rg-atlas-badge rg-phantom-facet", text: "GHOST" });
    head.createDiv({
      cls: "rg-atlas-meta",
      text: `cited by ${f.df} note${f.df === 1 ? "" : "s"}${f.bridgeScore ? ` · bridges ${f.bridgeScore} open pair${f.bridgeScore === 1 ? "" : "s"}` : ""}`
    });

    // co-occurring facets
    if (f.cooccur.length) {
      const sec = el.createDiv({ cls: "rg-atlas-section" });
      sec.createDiv({ cls: "rg-atlas-section-title", text: "APPEARS WITH" });
      const wrap = sec.createDiv({ cls: "rg-atlas-chips" });
      for (const c of f.cooccur) {
        const chip = wrap.createSpan({ cls: "rg-atlas-chip", attr: { role: "button" } });
        chip.createSpan({ text: c.label });
        chip.createSpan({ cls: "rg-atlas-chip-df", text: `×${c.weight}` });
        chip.onClickEvent(() => this.select(c.key));
      }
    }

    // member notes → open in Scope
    const notes = el.createDiv({ cls: "rg-atlas-section" });
    notes.createDiv({ cls: "rg-atlas-section-title", text: `NOTES (${f.notes.length})` });
    if (!f.notes.length) {
      notes.createDiv({ cls: "rg-box-empty", text: f.phantom ? "no note carries this yet" : "—" });
    }
    for (const path of f.notes) {
      const row = notes.createDiv({ cls: "rg-atlas-note", attr: { role: "button" } });
      row.setText(baseOf(path));
      row.onClickEvent(() => this.host.openInScope(path));
    }
  }
}

// ── helpers (mirrors of the Scope's) ───────────────────────────────────────────
function triangle(x: number, y: number, s: number): string {
  const h = s * 0.95;
  return `M ${x} ${y - h} L ${x + s} ${y + h * 0.78} L ${x - s} ${y + h * 0.78} Z`;
}
function ariaFor(f: AtlasFacet): string {
  const tags = [f.isHub ? "hub" : "", f.isBridge ? "bridge" : "", f.phantom ? "ghost facet" : ""].filter(Boolean);
  return `${f.label} — ${f.df} notes${tags.length ? ` (${tags.join(", ")})` : ""}`;
}
function baseOf(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/i, "");
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
