import { ItemView, type WorkspaceLeaf, type App } from "obsidian";
import { buildTreeFromGraph, type Tree } from "../engine/tree.ts";
import { subgraph, type FacetGraph } from "../engine/facetGraph.ts";

export const RHIZONE_FACET_VIEW_TYPE = "rhizone-facet";

const VIEW = 1400; // viewBox VIEW×VIEW; CSS scales to the pane, pan/zoom via the transform group
const C = VIEW / 2;
const R_OUT = 580; // the ever-present outer ring of all notes
const R_IN = 250; // the tight inner ring of notes summoned by the keystone
const INNER_CAP = 30; // most related notes pulled inward at once
const DOT = 5;

/** What the Rhizone view needs from the plugin. */
export interface RhizoneHost {
  app: App;
  /** Whole-vault facet model as the Ten Gateways (Etz Chaim) — used by the local-tree slice. */
  buildTree(): Tree;
  /** The whole-vault facet graph. */
  facetGraph(): FacetGraph;
  /** Notes citing a facet. */
  notesForFacet(key: string): { path: string; basename: string }[];
  /** Every note in the vault (the ambient galaxy ring). */
  allNotes(): { path: string; basename: string }[];
  /** A note's facet keys (to seed from a note keystone). */
  noteFacets(path: string): string[];
  /** Notes sharing any of `facetKeys`, rarity-ranked. */
  relatedNotes(facetKeys: string[], exclude?: string): { path: string; basename: string; rarestDf: number }[];
  /** Direct note→note links/connections across the whole vault (the ambient chord web). */
  noteLinks(): Array<[string, string]>;
  /** path → facet-community label (for cluster ordering). */
  noteClusters(): Record<string, string>;
  /** Reveal the Reticular Scope focused on a note (the resident view of what you summoned). */
  openInScope(path: string): void;
  /** Run motion, overriding OS reduce-motion (persisted, shared with the Scope). */
  animations(): boolean;
}

interface NoteRef {
  path: string;
  basename: string;
}

/**
 * Rhizone — the focus+context galaxy. Every note sits on an ever-present outer ring; the centre is
 * empty until you summon a keystone. Picking a note flies it to the centre and slides the notes that
 * share a rare facet into a tight inner ring; everything else stays out on the far circle. Pan/zoom
 * to roam. (Local Etz Chaim around the keystone + search are later slices.)
 */
export class RhizoneFacetView extends ItemView {
  private host: RhizoneHost;
  private keystone: { kind: "note" | "facet"; key: string } | null = null; // null = ambient
  private _graph: FacetGraph | null = null; // cached whole-vault graph (for local trees)
  private order: "cluster" | "alpha" = "cluster";
  private vt = { z: 1, tx: 0, ty: 0 };
  private cursor = -1; // arrow/scroll navigation index into the ambient outer ring
  private labelZoom = 55; // 0..100 → the zoom at which outer-ring labels appear

  private notes: NoteRef[] = [];
  private clusters: Record<string, string> = {};
  private _noteEls = new Map<string, SVGGElement>();
  private _pan: SVGElement | null = null;
  private _centerEl: SVGElement | null = null;
  private _linksEl: SVGElement | null = null;
  private _ksTitleEl: SVGElement | null = null; // the keystone's name, fixed above the ring
  private _scanTitleEl: SVGElement | null = null; // the note under the roam cursor, shown in the ring's centre
  private _titleEl: HTMLElement | null = null;
  private _releaseEl: HTMLElement | null = null;

  private _links: Array<[string, string]> = []; // cached vault link web (chords)
  private _linkEls = new Map<string, SVGLineElement[]>(); // path → its chord <line>s, for hover-brighten
  private _adj = new Map<string, string[]>(); // path → directly linked paths (for "show connected labels")
  private _hover: string | null = null; // note currently under the pointer (ambient)
  private _pos = new Map<string, { x: number; y: number }>(); // each note's current placed position
  private _inner = new Set<string>(); // notes currently on the inner ring (focused state)
  private _treeFacets = new Map<string, { x: number; y: number }>(); // local-tree Sephira facet positions

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
    this.build();
  }

  /** Rebuild from scratch (open / index change). */
  refresh(): void {
    this.build();
  }

  // ── one-time(ish) build of the whole field ──
  private build(): void {
    const root = this.contentEl;
    root.empty();
    root.toggleClass("rg-anim", this.host.animations());
    this._noteEls.clear();
    this._centerEl = null;
    this._linksEl = null;
    this._pos.clear();
    this._graph = null; // the index may have changed; rebuild the graph lazily

    try {
      this.notes = this.host.allNotes();
      this._links = this.host.noteLinks();
      this._adj.clear();
      for (const [a, b] of this._links) {
        (this._adj.get(a) ?? this._adj.set(a, []).get(a)!).push(b);
        (this._adj.get(b) ?? this._adj.set(b, []).get(b)!).push(a);
      }
      this.clusters = this.order === "cluster" ? this.host.noteClusters() : {};
    } catch (e) {
      root.createDiv({ cls: "rg-error" }).setText("Rhizone error:\n" + String((e as Error)?.stack ?? e));
      return;
    }

    // ── bezel: tag · title · order toggle · release ──
    const bezel = root.createDiv({ cls: "rg-bezel" });
    bezel.createSpan({ cls: "rg-bezel-tag", text: "RHIZONE" });
    this._titleEl = bezel.createSpan({ cls: "rg-bezel-title" });
    const orderBtn = bezel.createSpan({
      cls: "rg-gx-order",
      attr: { role: "button", "aria-label": "Toggle ring order" }
    });
    orderBtn.setText(this.order === "cluster" ? "clusters" : "a–z");
    orderBtn.onClickEvent(() => {
      this.order = this.order === "cluster" ? "alpha" : "cluster";
      orderBtn.setText(this.order === "cluster" ? "clusters" : "a–z");
      if (this.order === "cluster" && !Object.keys(this.clusters).length) this.clusters = this.host.noteClusters();
      this.layout();
    });
    const labelSlider = bezel.createEl("input", {
      cls: "rg-gx-labelzoom",
      attr: { type: "range", min: "0", max: "100", value: String(this.labelZoom), title: "When labels appear (by zoom)" }
    });
    labelSlider.addEventListener("input", () => {
      this.labelZoom = Number(labelSlider.value);
      this.applyTransform();
    });
    this._releaseEl = bezel.createSpan({ cls: "rg-rz-back", text: "‹ release", attr: { role: "button" } });
    this._releaseEl.onClickEvent(() => this.release());

    // ── stage / svg ──
    const stage = root.createDiv({ cls: "rg-tree-stage" });
    const svg = stage.createSvg("svg", {
      cls: ["rg-tree", "rg-gx"],
      attr: { viewBox: `0 0 ${VIEW} ${VIEW}`, role: "group", tabindex: "0", "aria-label": "The vault as a galaxy of notes" }
    });
    svg.addEventListener("click", (e) => {
      if (e.target !== svg) return; // a node/label handled the click itself
      // empty centre + something under the pointer → summon it (forgiving of the tiny dots)
      if (!this.keystone && this._hover) this.setKeystone({ kind: "note", key: this._hover });
      else this.release(); // otherwise, clicking the void lets go
    });
    svg.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") (e.preventDefault(), this.moveCursor(1));
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") (e.preventDefault(), this.moveCursor(-1));
      else if (e.key === "Enter") (e.preventDefault(), this.summonCursor());
      else if (e.key === "Escape") (e.preventDefault(), this.release());
    });
    const pan = svg.createSvg("g", { cls: "rg-gx-pan" });
    this._pan = pan;
    this.attachPanZoom(svg);

    // the keystone's name, pinned above the ring (fixed in the viewBox — pan/zoom don't move it)
    this._ksTitleEl = svg.createSvg("text", {
      cls: ["rg-gx-kstitle"],
      attr: { x: String(C), y: "72", "text-anchor": "middle" }
    });


    // entrance: lay the dots out in the OPPOSITE ordering, then reflow to the real one so every
    // note slides across the ring at once and the chords cross into that geometric scatter.
    const oppList = this.orderedFor(this.order === "cluster" ? "alpha" : "cluster");
    const oppPos = new Map<string, { x: number; y: number }>();
    oppList.forEach((n, i) => oppPos.set(n.path, ringXY(i, oppList.length, R_OUT)));

    // every note becomes a persistent dot we later slide around
    for (const n of this.notes) {
      const p0 = oppPos.get(n.path) ?? { x: C, y: C };
      const g = pan.createSvg("g", { cls: ["rg-gx-note"], attr: { "data-path": n.path, transform: `translate(${p0.x} ${p0.y})` } });
      g.createSvg("circle", { cls: ["rg-gx-dot"], attr: { cx: 0, cy: 0, r: DOT } });
      g.createSvg("text", { cls: ["rg-gx-label"], attr: { x: 0, y: -10, "text-anchor": "middle" } }).setText(
        trunc(displayLabel(n.basename), 28)
      );
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setKeystone({ kind: "note", key: n.path });
      });
      g.addEventListener("mouseover", (e) => {
        this._hover = n.path;
        this.highlightConnections(n.path);
        this.host.app.workspace.trigger("hover-link", {
          event: e,
          source: "reticular-graph",
          hoverParent: this,
          targetEl: g,
          linktext: n.basename,
          sourcePath: ""
        });
      });
      g.addEventListener("mouseout", () => {
        if (this._hover === n.path) this._hover = null;
        this.highlightConnections(null);
      });
      this._noteEls.set(n.path, g as SVGGElement);
    }

    // centre readout: the note you're scanning past on the ring (ambient roam)
    this._scanTitleEl = pan.createSvg("text", {
      cls: ["rg-gx-scan"],
      attr: { x: String(C), y: String(C), "text-anchor": "middle" }
    });

    const legend = root.createDiv({ cls: "rg-tree-legend" });
    legend.createSpan({ text: "click a note to summon · ←/→ or scroll to roam the ring · enter summons · ctrl-scroll zoom · drag pan" });

    this.applyTransform();
    // paint the entering (centred) state first, then fly the dots out + fade them in
    requestAnimationFrame(() => {
      this.layout();
      this._noteEls.forEach((g) => g.classList.remove("rg-enter"));
    });
  }

  private graph(): FacetGraph {
    return (this._graph ??= this.host.facetGraph());
  }

  private setKeystone(k: { kind: "note" | "facet"; key: string }): void {
    const same = !!this.keystone && this.keystone.kind === k.kind && this.keystone.key === k.key;
    this.keystone = same ? null : k;
    this.cursor = -1;
    this._noteEls.forEach((g) => g.classList.remove("rg-cursor"));
    if (this.keystone) this.panToCenter();
    // point the resident graph at the same note — tourist (Rhizone) ↔ resident (Reticular)
    if (this.keystone && this.keystone.kind === "note") this.host.openInScope(this.keystone.key);
    this.layout();
  }
  private release(): void {
    if (!this.keystone) return;
    this.keystone = null;
    this.layout();
  }

  /** Step a highlight cursor around the ambient outer ring (arrow keys / scroll). */
  private moveCursor(delta: number): void {
    if (this.keystone) return; // ring navigation is for the ambient view
    const ordered = this.orderedNotes();
    if (!ordered.length) return;
    this.cursor = this.cursor < 0 ? (delta > 0 ? 0 : ordered.length - 1) : (this.cursor + delta + ordered.length) % ordered.length;
    const note = ordered[this.cursor];
    this._noteEls.forEach((g) => g.classList.remove("rg-cursor"));
    this._noteEls.get(note.path)?.classList.add("rg-cursor");
    this.highlightConnections(note.path); // light its chords + reveal its connected notes' labels
    this.updateScanTitle();
  }

  /** Ambient: light a note's chords and reveal the labels of the notes it's connected to. */
  private highlightConnections(path: string | null): void {
    this._linksEl?.querySelectorAll(".rg-link-hot").forEach((el) => el.classList.remove("rg-link-hot"));
    this._noteEls.forEach((g) => g.classList.remove("rg-near"));
    if (!path || this.keystone) return;
    for (const ln of this._linkEls.get(path) ?? []) ln.classList.add("rg-link-hot");
    for (const nb of this._adj.get(path) ?? []) this._noteEls.get(nb)?.classList.add("rg-near");
  }

  /** Mirror the note under the roam cursor into the ring's centre (ambient only). */
  private updateScanTitle(): void {
    const el = this._scanTitleEl;
    if (!el) return;
    const ordered = this.keystone ? [] : this.orderedNotes();
    const note = this.cursor >= 0 ? ordered[this.cursor] : undefined;
    el.setText(note ? trunc(displayLabel(baseOf(note.path)), 32) : "");
    el.classList.toggle("is-on", !!note);
  }
  private summonCursor(): void {
    if (this.keystone) return void this.release();
    const ordered = this.orderedNotes();
    if (this.cursor >= 0 && this.cursor < ordered.length) this.setKeystone({ kind: "note", key: ordered[this.cursor].path });
  }

  /** zoom at/above which outer-ring labels appear (slider 0..100 → 0.5..3.0×). */
  private zThreshold(): number {
    return 0.5 + (this.labelZoom / 100) * 2.5;
  }
  /** Centre the galaxy in the viewBox (after summoning, the keystone sits dead-centre). */
  private panToCenter(): void {
    this.vt.tx = C * (1 - this.vt.z);
    this.vt.ty = C * (1 - this.vt.z);
    this.applyTransform();
  }

  // ── position every note for the current state (slides via CSS transition) ──
  private layout(): void {
    const ordered = this.orderedNotes();
    const ks = this.keystone;
    const ksName = ks ? displayLabel(ks.kind === "note" ? baseOf(ks.key) : ks.key) : "";
    if (this._titleEl) this._titleEl.setText(ks ? ksName : "the vault");
    this._ksTitleEl?.setText(ksName);
    this._releaseEl?.toggleClass("is-hidden", !ks);
    this.contentEl.toggleClass("rg-rz-focused", !!ks);
    this.updateScanTitle();

    if (!ks) {
      // ambient — everyone on the outer ring, undimmed, labels on hover only
      this._inner.clear();
      ordered.forEach((n, i) => this.place(n.path, ringXY(i, ordered.length, R_OUT), { dim: false, related: false, keystone: false }));
      this.drawCenter(null);
      this.drawLinks();
      return;
    }

    // focused — the keystone's rare-facet kin to the inner ring, the rest dimmed outside
    const baseFacets = ks.kind === "note" ? this.host.noteFacets(ks.key) : [ks.key];
    const ksNote = ks.kind === "note" ? ks.key : null;
    const related = this.host.relatedNotes(baseFacets, ksNote ?? undefined).slice(0, INNER_CAP);
    const innerSet = new Set(related.map((r) => r.path));
    this._inner = innerSet;

    // outer notes with a direct link/connection into the active set (keystone + inner ring)
    const activeSet = new Set(innerSet);
    if (ksNote) activeSet.add(ksNote);
    const connected = new Set<string>();
    for (const [a, b] of this._links) {
      if (activeSet.has(a) && !activeSet.has(b)) connected.add(b);
      else if (activeSet.has(b) && !activeSet.has(a)) connected.add(a);
    }

    if (ksNote) this.place(ksNote, { x: C, y: C }, { dim: false, related: false, keystone: true });
    related.forEach((r, i) => {
      if (r.path === ksNote) return;
      this.place(r.path, ringXY(i, related.length, R_IN), { dim: false, related: true, keystone: false });
    });
    const rest = ordered.filter((n) => n.path !== ksNote && !innerSet.has(n.path));
    rest.forEach((n, i) => {
      const linked = connected.has(n.path); // tied to the active set → stays lit + labelled
      this.place(n.path, ringXY(i, rest.length, R_OUT), { dim: !linked, related: false, keystone: false, linked });
    });

    this.drawCenter(ks);
    this.drawLinks();
  }

  private place(
    path: string,
    p: { x: number; y: number },
    s: { dim: boolean; related: boolean; keystone: boolean; linked?: boolean }
  ): void {
    const g = this._noteEls.get(path);
    if (!g) return;
    this._pos.set(path, p);
    g.setAttribute("transform", `translate(${p.x} ${p.y})`);
    g.classList.toggle("rg-dim", s.dim);
    g.classList.toggle("rg-related", s.related);
    g.classList.toggle("rg-keystone", s.keystone);
    g.classList.toggle("rg-linked", !!s.linked);
    // fan the label outward from the galaxy centre, anchored by its angle
    const label = g.querySelector(".rg-gx-label");
    if (label) {
      const dx = p.x - C;
      const dy = p.y - C;
      const len = Math.hypot(dx, dy) || 1;
      const off = DOT + 12;
      label.setAttribute("x", String((dx / len) * off));
      label.setAttribute("y", String((dy / len) * off + 4));
      label.setAttribute("text-anchor", dx > len * 0.3 ? "start" : dx < -len * 0.3 ? "end" : "middle");
    }
  }

  /** The centre marker (the keystone's name). Cleared/rebuilt each focus. (Slice 3: the local tree.) */
  /** The local Etz Chaim — recomputed on the keystone's facets + one hop — fades in at the centre. */
  private drawCenter(ks: { kind: "note" | "facet"; key: string } | null): void {
    this._centerEl?.remove();
    this._centerEl = null;
    this._treeFacets.clear();
    if (!ks || !this._pan) return;

    const g = this.graph();
    const base = ks.kind === "note" ? this.host.noteFacets(ks.key) : [ks.key];
    const seed = new Set<string>();
    for (const f of base) {
      if (!g.nodes.has(f)) continue;
      seed.add(f);
      for (const nb of g.adjacency.get(f) ?? []) seed.add(nb.key); // one hop
    }
    if (!seed.size) return;
    const tree = buildTreeFromGraph(subgraph(g, seed));

    const grp = this._pan.createSvg("g", { cls: ["rg-gx-center"] });
    this._centerEl = grp;
    const BOX = 380;
    const tx = (x: number): number => C + (x - 0.5) * BOX;
    const ty = (y: number): number => C + (y - 0.5) * BOX;

    const pos = new Map<string, { x: number; y: number }>();
    for (const gw of tree.gateways) {
      if (!gw.facet) continue;
      const p = { x: tx(gw.x), y: ty(gw.y) };
      pos.set(gw.name, p);
      this._treeFacets.set(gw.facet.key, p); // so inner-ring notes can tie to their facet node
    }
    for (const p of tree.paths) {
      const a = pos.get(p.from);
      const b = pos.get(p.to);
      if (!a || !b) continue;
      const line = grp.createSvg("line", { cls: ["rg-lt-path"], attr: { x1: a.x, y1: a.y, x2: b.x, y2: b.y } });
      line.style.setProperty("--rg-path-strength", String(0.12 + p.affinity * 0.6));
    }
    for (const gw of tree.gateways) {
      if (!gw.facet) continue;
      const p = pos.get(gw.name)!;
      const node = grp.createSvg("g", { cls: ["rg-lt-node"], attr: { role: "button", "aria-label": gw.facet.label } });
      node.createSvg("circle", { cls: ["rg-lt-dot"], attr: { cx: p.x, cy: p.y, r: 7 } });
      node.createSvg("text", { cls: ["rg-lt-label"], attr: { x: p.x, y: p.y - 12, "text-anchor": "middle" } }).setText(
        trunc(displayLabel(gw.facet.label), 18)
      );
      const key = gw.facet.key;
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setKeystone({ kind: "facet", key });
      });
    }
  }

  /**
   * Connecting lines, redrawn at the notes' current positions and laid BEHIND the dots:
   *   • the vault's direct note→note links/connections, as faint chords (ring ↔ ring);
   *   • when focused, each inner-ring note tied to the local-tree facet node it actually cites
   *     (its attachment to the structure — never to the keystone itself).
   */
  private drawLinks(): void {
    this._linksEl?.remove();
    this._linksEl = null;
    if (!this._pan) return;
    const grp = this._pan.createSvg("g", { cls: ["rg-gx-links"] });
    this._pan.insertBefore(grp, this._pan.firstChild); // behind the note dots + the centre tree
    this._linksEl = grp;
    this._linkEls.clear();

    // focused: dim every chord but the ones touching the keystone or its inner ring (active here & now)
    const ksNote = this.keystone && this.keystone.kind === "note" ? this.keystone.key : null;
    const active = (p: string): boolean => p === ksNote || this._inner.has(p);
    grp.classList.toggle("rg-focused", !!this.keystone);

    // chords: every direct link/connection whose endpoints are both placed
    for (const [a, b] of this._links) {
      const pa = this._pos.get(a);
      const pb = this._pos.get(b);
      if (!pa || !pb) continue;
      const ln = grp.createSvg("line", { cls: ["rg-gx-link"], attr: { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y } }) as SVGLineElement;
      (this._linkEls.get(a) ?? this._linkEls.set(a, []).get(a)!).push(ln);
      (this._linkEls.get(b) ?? this._linkEls.set(b, []).get(b)!).push(ln);
      if (this.keystone && (active(a) || active(b))) ln.classList.add("rg-link-active");
    }

    // ties: inner-ring note → each local-tree facet it cites
    if (this.keystone && this._treeFacets.size) {
      for (const path of this._inner) {
        const p = this._pos.get(path);
        if (!p) continue;
        for (const fk of this.host.noteFacets(path)) {
          const tp = this._treeFacets.get(fk);
          if (tp) grp.createSvg("line", { cls: ["rg-gx-tie"], attr: { x1: p.x, y1: p.y, x2: tp.x, y2: tp.y } });
        }
      }
    }
  }

  private orderedNotes(): NoteRef[] {
    return this.orderedFor(this.order);
  }
  private orderedFor(order: "cluster" | "alpha"): NoteRef[] {
    const ns = [...this.notes];
    if (order === "alpha") {
      ns.sort((a, b) => a.basename.localeCompare(b.basename));
    } else {
      ns.sort(
        (a, b) =>
          (this.clusters[a.path] ?? "~").localeCompare(this.clusters[b.path] ?? "~") || a.basename.localeCompare(b.basename)
      );
    }
    return ns;
  }

  // ── pan + zoom ──
  private applyTransform(): void {
    this._pan?.setAttribute("transform", `translate(${this.vt.tx} ${this.vt.ty}) scale(${this.vt.z})`);
    this.contentEl.toggleClass("rg-show-labels", this.vt.z >= this.zThreshold());
  }

  /** Client pixel → viewBox coords (handles the SVG's letterboxing/aspect via its screen matrix). */
  private toViewBox(svg: SVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
    const ctm = (svg as SVGSVGElement).getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }
  private attachPanZoom(svg: SVGElement): void {
    svg.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey || this.keystone) {
          const f = e.deltaY < 0 ? 1.12 : 1 / 1.12; // ctrl-scroll (or while focused) = zoom
          const z2 = Math.min(4, Math.max(0.35, this.vt.z * f));
          const vb = this.toViewBox(svg, e.clientX, e.clientY); // pointer-aware: keep the point under the cursor fixed
          if (vb) {
            this.vt.tx = vb.x - (vb.x - this.vt.tx) * (z2 / this.vt.z);
            this.vt.ty = vb.y - (vb.y - this.vt.ty) * (z2 / this.vt.z);
          }
          this.vt.z = z2;
          this.applyTransform();
        } else {
          this.moveCursor(e.deltaY > 0 ? 1 : -1); // plain scroll = roam the ring
        }
      },
      { passive: false }
    );
    let dragging = false;
    let lx = 0;
    let ly = 0;
    svg.addEventListener("pointerdown", (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      svg.addClass("rg-grabbing");
      (svg as unknown as HTMLElement).focus?.(); // so arrow keys work after a click
    });
    svg.addEventListener("pointermove", (e: PointerEvent) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const scale = rect.width ? VIEW / rect.width : 1; // px → viewBox units
      this.vt.tx += (e.clientX - lx) * scale;
      this.vt.ty += (e.clientY - ly) * scale;
      lx = e.clientX;
      ly = e.clientY;
      this.applyTransform();
    });
    const end = (): void => {
      dragging = false;
      svg.removeClass("rg-grabbing");
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointerleave", end);
  }
}

function ringXY(i: number, n: number, r: number): { x: number; y: number } {
  const ang = -Math.PI / 2 + (n <= 0 ? 0 : (i / n) * Math.PI * 2);
  return { x: C + Math.cos(ang) * r, y: C + Math.sin(ang) * r };
}

function baseOf(p: string): string {
  return p.split("/").pop()!.replace(/\.md$/i, "");
}
function displayLabel(label: string): string {
  return label.replace(/^[A-Z][A-Za-z]+ - /, "");
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
