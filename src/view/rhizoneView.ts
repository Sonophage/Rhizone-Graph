import { ItemView, type WorkspaceLeaf, type App } from "obsidian";
import type { Tree } from "../engine/tree.ts";
import type { FacetGraph } from "../engine/facetGraph.ts";

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
  /** path → facet-community label (for cluster ordering). */
  noteClusters(): Record<string, string>;
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
  private keystone: string | null = null; // a note path; null = ambient
  private order: "cluster" | "alpha" = "cluster";
  private vt = { z: 1, tx: 0, ty: 0 };

  private notes: NoteRef[] = [];
  private clusters: Record<string, string> = {};
  private _noteEls = new Map<string, SVGGElement>();
  private _pan: SVGElement | null = null;
  private _centerEl: SVGElement | null = null;
  private _titleEl: HTMLElement | null = null;
  private _releaseEl: HTMLElement | null = null;

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

    try {
      this.notes = this.host.allNotes();
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
    this._releaseEl = bezel.createSpan({ cls: "rg-rz-back", text: "‹ release", attr: { role: "button" } });
    this._releaseEl.onClickEvent(() => this.release());

    // ── stage / svg ──
    const stage = root.createDiv({ cls: "rg-tree-stage" });
    const svg = stage.createSvg("svg", {
      cls: ["rg-tree", "rg-gx"],
      attr: { viewBox: `0 0 ${VIEW} ${VIEW}`, role: "group", "aria-label": "The vault as a galaxy of notes" }
    });
    svg.addEventListener("click", (e) => {
      if (e.target === svg) this.release(); // click the void → let go
    });
    const pan = svg.createSvg("g", { cls: "rg-gx-pan" });
    this._pan = pan;
    this.attachPanZoom(svg);

    // every note becomes a persistent dot we later slide around
    for (const n of this.notes) {
      const g = pan.createSvg("g", { cls: ["rg-gx-note"], attr: { "data-path": n.path, transform: `translate(${C} ${C})` } });
      g.createSvg("circle", { cls: ["rg-gx-dot"], attr: { cx: 0, cy: 0, r: DOT } });
      g.createSvg("text", { cls: ["rg-gx-label"], attr: { x: 0, y: -10, "text-anchor": "middle" } }).setText(
        trunc(displayLabel(n.basename), 28)
      );
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggle(n.path);
      });
      g.addEventListener("mouseover", (e) =>
        this.host.app.workspace.trigger("hover-link", {
          event: e,
          source: "reticular-graph",
          hoverParent: this,
          targetEl: g,
          linktext: n.basename,
          sourcePath: ""
        })
      );
      this._noteEls.set(n.path, g as SVGGElement);
    }

    const legend = root.createDiv({ cls: "rg-tree-legend" });
    legend.createSpan({ text: "click a note to summon it · click again (or the void) to release · scroll zoom · drag pan" });

    this.applyTransform();
    this.layout();
  }

  private toggle(path: string): void {
    this.keystone = this.keystone === path ? null : path;
    this.layout();
  }
  private release(): void {
    if (!this.keystone) return;
    this.keystone = null;
    this.layout();
  }

  // ── position every note for the current state (slides via CSS transition) ──
  private layout(): void {
    const ordered = this.orderedNotes();
    if (this._titleEl) this._titleEl.setText(this.keystone ? displayLabel(baseOf(this.keystone)) : "the vault");
    this._releaseEl?.toggleClass("is-hidden", !this.keystone);

    if (!this.keystone) {
      // ambient — everyone on the outer ring, undimmed, labels on hover only
      ordered.forEach((n, i) => this.place(n.path, ringXY(i, ordered.length, R_OUT), { dim: false, related: false, keystone: false }));
      this.drawCenter(null);
      return;
    }

    // focused — keystone to centre, its rare-facet kin to the inner ring, the rest dimmed outside
    const facets = this.host.noteFacets(this.keystone);
    const related = this.host.relatedNotes(facets, this.keystone).slice(0, INNER_CAP);
    const inner = related.map((r) => r.path);
    const innerSet = new Set(inner);

    this.place(this.keystone, { x: C, y: C }, { dim: false, related: false, keystone: true });
    inner.forEach((p, i) => this.place(p, ringXY(i, inner.length, R_IN), { dim: false, related: true, keystone: false }));

    const rest = ordered.filter((n) => n.path !== this.keystone && !innerSet.has(n.path));
    rest.forEach((n, i) => this.place(n.path, ringXY(i, rest.length, R_OUT), { dim: true, related: false, keystone: false }));

    this.drawCenter(this.keystone);
  }

  private place(path: string, p: { x: number; y: number }, s: { dim: boolean; related: boolean; keystone: boolean }): void {
    const g = this._noteEls.get(path);
    if (!g) return;
    g.setAttribute("transform", `translate(${p.x} ${p.y})`);
    g.classList.toggle("rg-dim", s.dim);
    g.classList.toggle("rg-related", s.related);
    g.classList.toggle("rg-keystone", s.keystone);
  }

  /** The centre marker (the keystone's name). Cleared/rebuilt each focus. (Slice 3: the local tree.) */
  private drawCenter(keystone: string | null): void {
    this._centerEl?.remove();
    this._centerEl = null;
    if (!keystone || !this._pan) return;
    const g = this._pan.createSvg("g", { cls: ["rg-gx-center"] });
    g.createSvg("text", { cls: ["rg-gx-center-label"], attr: { x: C, y: C + 36, "text-anchor": "middle" } }).setText(
      trunc(displayLabel(baseOf(keystone)), 30)
    );
    this._centerEl = g;
  }

  private orderedNotes(): NoteRef[] {
    const ns = [...this.notes];
    if (this.order === "alpha") {
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
  }
  private attachPanZoom(svg: SVGElement): void {
    svg.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.vt.z = Math.min(4, Math.max(0.35, this.vt.z * f));
        this.applyTransform();
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
