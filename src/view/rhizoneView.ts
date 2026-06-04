import { ItemView, Menu, Notice, debounce, type WorkspaceLeaf, type App } from "obsidian";
import { buildTreeFromGraph, type Tree } from "../engine/tree.ts";
import { subgraph, type FacetGraph } from "../engine/facetGraph.ts";

export const RHIZONE_FACET_VIEW_TYPE = "rhizone-facet";

const VIEW = 1600; // viewBox VIEW×VIEW; CSS scales to the pane, pan/zoom via the transform group
const C = VIEW / 2;
const R_OUT = 680; // the ever-present outer ring of all notes
const R_GHOST = 770; // the outermost ring: ghost notes (phantom facets — referenced, never written)
const R_IN = 290; // the tight inner ring of notes summoned by the keystone
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
  /** Notes sharing any of `facetKeys`, rarity-ranked, with the rarest shared facet as the "why". */
  relatedNotes(
    facetKeys: string[],
    exclude?: string
  ): { path: string; basename: string; rarestDf: number; via: { key: string; label: string } }[];
  /** Direct note→note links/connections across the whole vault (the ambient chord web). */
  noteLinks(): Array<[string, string]>;
  /** path → facet-community label (for cluster ordering). */
  noteClusters(): Record<string, string>;
  /** Search filename + body; returns the best candidate doors (name-match weighted over body). */
  searchNotes(query: string, limit?: number): Promise<{ path: string; basename: string }[]>;
  /** A short plain-text peek at a note's body, for the door cards. */
  noteExcerpt(path: string, len?: number): Promise<string>;
  /** Weld a bidirectional connections: edge between two notes (graduates the pair into Reticular). */
  forge(focusPath: string, candidatePath: string): Promise<void>;
  /** Undo a forge — drop the bidirectional edge. */
  removeConnection(focusPath: string, candidatePath: string): Promise<void>;
  /** Create the unwritten note behind a phantom facet (empty), open it, return its path. */
  createGhostNote(key: string): Promise<string | null>;
  /** Open a note in the editor (optionally a new tab). */
  openNote(path: string, newLeaf?: boolean): void;
  /** Reveal the Reticular Scope focused on a note (the resident view of what you summoned). */
  openInScope(path: string): void;
  /** Point an already-open Reticular Scope at a note without revealing it (live highlight sync). */
  syncScope(path: string): void;
  /** Run motion, overriding OS reduce-motion (persisted, shared with the Scope). */
  animations(): boolean;
}

interface NoteRef {
  path: string;
  basename: string;
}

/** A clickable thing in the galaxy: a note dot or a ghost (phantom-facet) dot. */
type GxTarget = { kind: "note"; key: string } | { kind: "ghost"; key: string };

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
  private _ghosts: { key: string; label: string }[] = []; // phantom facets, alpha-ordered
  private _noteEls = new Map<string, SVGGElement>();
  private _ghostEls = new Map<string, SVGGElement>();
  private _pan: SVGElement | null = null;
  private _centerEl: SVGElement | null = null;
  private _linksEl: SVGElement | null = null;
  private _ksTitleEl: SVGElement | null = null; // the keystone's name, fixed above the ring
  private _scanTitleEl: SVGElement | null = null; // the note under the roam cursor, shown in the ring's centre
  private _searchEl: HTMLInputElement | null = null;
  private _resultsEl: HTMLElement | null = null; // search results panel (the three candidate doors)
  private _panelEl: HTMLElement | null = null; // connections panel (the kin list, on focus)
  private _dailyEl: HTMLElement | null = null; // "today's door" reading (ambient centre)
  private _drawOffset = 0; // "another" cycles the daily pool
  private _searchSeq = 0; // guards against out-of-order async search results
  private _titleEl: HTMLElement | null = null;
  private _releaseEl: HTMLElement | null = null;

  private _links: Array<[string, string]> = []; // cached vault link web (chords)
  private _ghostLinks: Array<[string, string]> = []; // [ghostKey, notePath] — a note that calls a phantom facet
  private _linkEls = new Map<string, SVGLineElement[]>(); // key → its chord <line>s, for hover-brighten
  private _tieEls = new Map<string, SVGLineElement[]>(); // tree facet key → inner-ring tie <line>s
  private _adj = new Map<string, string[]>(); // key → directly linked keys (notes + ghosts, for "show connected labels")
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
    this._ghostEls.clear();
    this._centerEl = null;
    this._linksEl = null;
    this._pos.clear();
    this._graph = null; // the index may have changed; rebuild the graph lazily

    try {
      this.notes = this.host.allNotes();
      this._ghosts = this.ghostList();
      this._links = this.host.noteLinks();
      this._adj.clear();
      for (const [a, b] of this._links) {
        (this._adj.get(a) ?? this._adj.set(a, []).get(a)!).push(b);
        (this._adj.get(b) ?? this._adj.set(b, []).get(b)!).push(a);
      }
      // a note "connects" to a ghost it calls (wikilinks a never-written target)
      this._ghostLinks = [];
      for (const gh of this._ghosts) {
        for (const nf of this.host.notesForFacet(gh.key)) {
          this._ghostLinks.push([gh.key, nf.path]);
          (this._adj.get(gh.key) ?? this._adj.set(gh.key, []).get(gh.key)!).push(nf.path);
          (this._adj.get(nf.path) ?? this._adj.set(nf.path, []).get(nf.path)!).push(gh.key);
        }
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

    // ── search: find a door (filename + body) → pick from three; or wander to a rare one ──
    const search = bezel.createEl("input", {
      cls: "rg-gx-search",
      attr: { type: "search", placeholder: "find a door…", spellcheck: "false" }
    });
    this._searchEl = search;
    const wander = bezel.createSpan({ cls: "rg-gx-wander", text: "⚄ wander", attr: { role: "button", "aria-label": "Wander to a rare door" } });
    wander.onClickEvent(() => this.wander());
    const debouncedSearch = debounce((q: string) => void this.runSearch(q), 200, false);
    search.addEventListener("input", () => debouncedSearch(search.value));
    search.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") (search.value = "", this.clearResults());
      else if (e.key === "Enter") {
        const first = this._resultsEl?.querySelector<HTMLElement>(".rg-door-card");
        first?.click(); // Enter opens the top door
      }
    });
    this._resultsEl = root.createDiv({ cls: "rg-gx-results", attr: { "aria-hidden": "true" } });
    this._resultsEl.addEventListener("click", (e) => {
      if (e.target === this._resultsEl) (search.value = "", this.clearResults()); // click the dim backdrop → close
    });

    // ── stage / svg ──
    const stage = root.createDiv({ cls: "rg-tree-stage" });
    const svg = stage.createSvg("svg", {
      cls: ["rg-tree", "rg-gx"],
      attr: { viewBox: `0 0 ${VIEW} ${VIEW}`, role: "group", tabindex: "0", "aria-label": "The vault as a galaxy of notes" }
    });
    svg.addEventListener("click", (e) => {
      if (e.target !== svg) return; // a node/label handled the click itself
      if (!this.keystone) {
        // empty centre → summon the highlighted (scrolled-to) note, else whatever's under the pointer
        const ordered = this.orderedNotes();
        const target = this.cursor >= 0 && ordered[this.cursor] ? ordered[this.cursor].path : this._hover;
        if (target) return void this.setKeystone({ kind: "note", key: target });
      }
      this.release(); // otherwise, clicking the void lets go
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
        // alt-click a rare kin in focus → forge straight away (power shortcut)
        if (e.altKey && this.keystone?.kind === "note" && this._inner.has(n.path)) {
          void this.forgeWith(n.path);
          return;
        }
        this.openNodeMenu({ kind: "note", key: n.path }, e); // click → actions
      });
      g.addEventListener("mouseover", () => {
        this._hover = n.path;
        this.highlightConnections(n.path);
      });
      g.addEventListener("mouseout", () => {
        if (this._hover === n.path) this._hover = null;
        this.highlightConnections(null);
      });
      this._noteEls.set(n.path, g as SVGGElement);
    }

    // the outermost ring: ghost notes (phantom facets). Same dots, scatter-in from reverse order.
    const oppGhost = [...this._ghosts].reverse();
    const oppGhostPos = new Map<string, { x: number; y: number }>();
    oppGhost.forEach((gh, i) => oppGhostPos.set(gh.key, ringXY(i, oppGhost.length, R_GHOST)));
    for (const gh of this._ghosts) {
      const p0 = oppGhostPos.get(gh.key) ?? { x: C, y: C };
      const g = pan.createSvg("g", {
        cls: ["rg-gx-note", "rg-gx-ghost"],
        attr: { "data-ghost": gh.key, transform: `translate(${p0.x} ${p0.y})` }
      });
      g.createSvg("circle", { cls: ["rg-gx-dot"], attr: { cx: 0, cy: 0, r: DOT } });
      g.createSvg("text", { cls: ["rg-gx-label"], attr: { x: 0, y: -10, "text-anchor": "middle" } }).setText(
        trunc(displayLabel(gh.label), 28)
      );
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openNodeMenu({ kind: "ghost", key: gh.key }, e);
      });
      g.addEventListener("mouseover", () => this.highlightConnections(gh.key));
      g.addEventListener("mouseout", () => this.highlightConnections(null));
      this._ghostEls.set(gh.key, g as SVGGElement);
    }

    // centre readout: the note you're scanning past on the ring (ambient roam)
    this._scanTitleEl = pan.createSvg("text", {
      cls: ["rg-gx-scan"],
      attr: { x: String(C), y: String(C), "text-anchor": "middle" }
    });

    // connections panel — the readable, keyboard-reachable face of the kin (shown on focus)
    this._panelEl = root.createDiv({ cls: "rg-cx-panel", attr: { "aria-hidden": "true" } });
    // today's door — a date-seeded ripe coincidence, offered in the empty centre (ambient)
    this._dailyEl = root.createDiv({ cls: "rg-daily", attr: { "aria-hidden": "true" } });

    const legend = root.createDiv({ cls: "rg-tree-legend" });
    legend.createSpan({
      text: "click a node for actions · ←/→ or scroll to roam · enter summons · alt-click a kin to forge · ctrl-scroll zoom · drag pan"
    });

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

  /** Phantom facets — wikilink targets with no note behind them — alpha by label. */
  private ghostList(): { key: string; label: string }[] {
    return [...this.graph().nodes.values()]
      .filter((n) => n.phantom)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((n) => ({ key: n.key, label: n.label }));
  }

  // ── search: three candidate doors, each with its body peek + connections ──
  private async runSearch(query: string): Promise<void> {
    if (!query.trim()) return this.clearResults();
    const seq = ++this._searchSeq;
    const hits = await this.host.searchNotes(query, 3);
    if (seq !== this._searchSeq) return; // a newer query landed first
    const excerpts = await Promise.all(hits.map((h) => this.host.noteExcerpt(h.path, 200)));
    if (seq !== this._searchSeq) return;
    this.renderCandidates(hits, excerpts);
  }

  private clearResults(): void {
    this._searchSeq++;
    if (!this._resultsEl) return;
    this._resultsEl.empty();
    this._resultsEl.setAttr("aria-hidden", "true");
    this.contentEl.removeClass("rg-searching");
  }

  /** A door's connections — its linked notes (and called ghosts), de-duped, by display name. */
  private connectionNames(path: string, cap = 5): { names: string[]; extra: number } {
    const uniq = [...new Set(this._adj.get(path) ?? [])];
    const names = uniq.slice(0, cap).map((c) => trunc(displayLabel(this._noteEls.has(c) ? baseOf(c) : c), 18));
    return { names, extra: Math.max(0, uniq.length - cap) };
  }

  /** A small SVG door drawn into a card. */
  private drawDoor(parent: HTMLElement): void {
    const svg = parent.createSvg("svg", { cls: ["rg-door-svg"], attr: { viewBox: "0 0 60 92" } });
    svg.createSvg("path", { cls: ["rg-door-frame"], attr: { d: "M9 90 L9 28 Q9 6 30 6 Q51 6 51 28 L51 90 Z" } });
    svg.createSvg("path", { cls: ["rg-door-panel"], attr: { d: "M15 84 L15 31 Q15 14 30 14 Q45 14 45 31 L45 84 Z" } });
    svg.createSvg("circle", { cls: ["rg-door-knob"], attr: { cx: 41, cy: 55, r: 2.4 } });
  }

  /** Three door cards over a blurred view: a door, the note's name, a body peek, its connections. */
  private renderCandidates(hits: { path: string; basename: string }[], excerpts: string[]): void {
    const host = this._resultsEl;
    if (!host) return;
    host.empty();
    host.setAttr("aria-hidden", "false");
    this.contentEl.addClass("rg-searching"); // blur the galaxy behind
    if (!hits.length) {
      host.createDiv({ cls: "rg-sr-empty", text: "no doors found" });
      return;
    }
    const row = host.createDiv({ cls: "rg-door-row" });
    hits.forEach((h, i) => {
      const card = row.createDiv({ cls: "rg-door-card", attr: { role: "button", "aria-label": h.basename } });
      this.drawDoor(card);
      card.createDiv({ cls: "rg-door-title", text: trunc(displayLabel(h.basename), 28) });
      card.createDiv({ cls: "rg-door-snippet", text: excerpts[i] || "—" });
      const { names, extra } = this.connectionNames(h.path);
      const conns = card.createDiv({ cls: "rg-door-conns" });
      if (!names.length) conns.createSpan({ cls: "rg-door-conn rg-door-conn-none", text: "no connections" });
      for (const nm of names) conns.createSpan({ cls: "rg-door-conn", text: nm });
      if (extra > 0) conns.createSpan({ cls: "rg-door-conn rg-door-conn-more", text: `+${extra}` });
      card.addEventListener("click", () => {
        if (this._searchEl) this._searchEl.value = "";
        this.clearResults();
        this.setKeystone({ kind: "note", key: h.path });
      });
    });
  }

  /** Wander: drop onto a random rare door (a note whose rarest facet is rarest). */
  private wander(): void {
    const g = this.graph();
    const scored = this.notes
      .map((n) => {
        let min = Infinity;
        for (const fk of this.host.noteFacets(n.path)) {
          const df = g.nodes.get(fk)?.df ?? Infinity;
          if (df < min) min = df;
        }
        return { path: n.path, min };
      })
      .filter((x) => x.min < Infinity)
      .sort((a, b) => a.min - b.min);
    if (!scored.length) return;
    const pool = scored.slice(0, Math.max(1, Math.floor(scored.length / 4))); // the rarest quartile
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (this._searchEl) this._searchEl.value = "";
    this.clearResults();
    this.setKeystone({ kind: "note", key: pick.path });
  }

  private hidePanel(): void {
    if (!this._panelEl) return;
    this._panelEl.empty();
    this._panelEl.setAttr("aria-hidden", "true");
  }

  /** The connections panel: the keystone's kin (notes + unwritten ghost-kin) with the WHY + actions. */
  private renderPanel(
    ks: { kind: "note" | "facet"; key: string },
    related: { path: string; basename: string; via: { key: string; label: string } }[],
    ghostKin: string[]
  ): void {
    const p = this._panelEl;
    if (!p) return;
    p.empty();
    p.setAttr("aria-hidden", "false");
    p.createDiv({ cls: "rg-cx-head", text: `kin · ${displayLabel(ks.kind === "note" ? baseOf(ks.key) : ks.key)}` });
    const list = p.createDiv({ cls: "rg-cx-list" });

    const row = (cls: string, name: string, why: string): HTMLElement => {
      const r = list.createDiv({ cls, attr: { tabindex: "0", role: "button" } });
      r.createSpan({ cls: "rg-cx-name", text: trunc(name, 28) });
      r.createSpan({ cls: "rg-cx-via", text: why });
      return r;
    };
    const btn = (host: HTMLElement, label: string, run: () => void): void => {
      const b = host.createEl("button", { cls: "rg-cx-btn", text: label });
      b.addEventListener("click", (e) => (e.stopPropagation(), run()));
    };

    if (!related.length && !ghostKin.length) {
      list.createDiv({ cls: "rg-cx-empty", text: "no undrawn kin — everything here is already connected" });
    }
    for (const r of related) {
      const el = row("rg-cx-row", displayLabel(baseOf(r.path)), `via ${trunc(displayLabel(r.via.label), 22)}`);
      const acts = el.createSpan({ cls: "rg-cx-acts" });
      btn(acts, "open", () => this.runAction("open", { kind: "note", key: r.path }));
      btn(acts, "forge", () => this.runAction("forge", { kind: "note", key: r.path }));
      el.addEventListener("mouseover", () => this.highlightConnections(r.path));
      el.addEventListener("mouseout", () => this.highlightConnections(null));
      el.addEventListener("click", () => this.runAction("summon", { kind: "note", key: r.path }));
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") this.runAction("summon", { kind: "note", key: r.path });
      });
    }
    for (const k of ghostKin) {
      const label = this._ghosts.find((g) => g.key === k)?.label ?? k;
      const el = row("rg-cx-row rg-cx-ghost", displayLabel(label), "unwritten");
      const acts = el.createSpan({ cls: "rg-cx-acts" });
      btn(acts, "create", () => this.runAction("create", { kind: "ghost", key: k }));
      el.addEventListener("mouseover", () => this.highlightConnections(k));
      el.addEventListener("mouseout", () => this.highlightConnections(null));
      el.addEventListener("click", () => this.runAction("summon", { kind: "ghost", key: k }));
    }
  }

  /** Open the action menu for a galaxy node (click). Actions route through runAction(). */
  private openNodeMenu(t: GxTarget, evt: MouseEvent): void {
    const menu = new Menu();
    if (t.kind === "note") {
      menu.addItem((i) => i.setTitle("Summon").setIcon("crosshair").onClick(() => this.runAction("summon", t)));
      menu.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => this.runAction("open", t)));
      menu.addItem((i) => i.setTitle("Open in new pane").setIcon("columns").onClick(() => this.runAction("open-pane", t)));
      if (this.keystone?.kind === "note" && this._inner.has(t.key)) {
        menu.addItem((i) => i.setTitle("Forge connection").setIcon("link").onClick(() => this.runAction("forge", t)));
      }
      menu.addItem((i) => i.setTitle("Reveal in Reticular").setIcon("git-fork").onClick(() => this.runAction("reveal", t)));
    } else {
      menu.addItem((i) => i.setTitle("Enter the unwritten door").setIcon("door-open").onClick(() => this.runAction("summon", t)));
      menu.addItem((i) =>
        i
          .setTitle(this.keystone?.kind === "note" ? "Create note + link to keystone" : "Create note")
          .setIcon("file-plus")
          .onClick(() => this.runAction("create", t))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** Single dispatcher for every node action (menu / panel rows / keyboard / alt-click share it). */
  private runAction(verb: string, t: GxTarget): void {
    switch (verb) {
      case "summon":
        this.setKeystone(t.kind === "note" ? { kind: "note", key: t.key } : { kind: "facet", key: t.key });
        break;
      case "open":
        if (t.kind === "note") this.host.openNote(t.key);
        break;
      case "open-pane":
        if (t.kind === "note") this.host.openNote(t.key, true);
        break;
      case "forge":
        if (t.kind === "note") void this.forgeWith(t.key);
        break;
      case "reveal":
        if (t.kind === "note") this.host.openInScope(t.key);
        break;
      case "create":
        if (t.kind === "ghost") void this.createFromGhost(t.key);
        break;
    }
  }

  /** Forge-from-ghost: write the unwritten note, and if focused, link it to the keystone. */
  private async createFromGhost(key: string): Promise<void> {
    const label = this._ghosts.find((g) => g.key === key)?.label ?? key;
    const path = await this.host.createGhostNote(key);
    if (!path) return void new Notice("could not create the note");
    if (this.keystone?.kind === "note") {
      await this.host.forge(this.keystone.key, path);
      new Notice(`created · ${displayLabel(label)} — linked to ${displayLabel(baseOf(this.keystone.key))}`);
    } else {
      new Notice(`created · ${displayLabel(label)}`);
    }
  }

  // ── today's door: a date-seeded ripe coincidence to forge ──
  /** Ripe coincidences: pairs joined ONLY by a rare (df=2) facet and not yet connected. */
  private ripePool(): { a: NoteRef; b: NoteRef; via: { key: string; label: string } }[] {
    const g = this.graph();
    const linked = new Set<string>();
    const pk = (x: string, y: string): string => (x < y ? x + "|" + y : y + "|" + x);
    for (const [x, y] of this._links) linked.add(pk(x, y));
    const out: { a: NoteRef; b: NoteRef; via: { key: string; label: string } }[] = [];
    for (const node of g.nodes.values()) {
      if (node.df !== 2) continue; // exactly two notes → an unambiguous coincidence
      const notes = this.host.notesForFacet(node.key);
      if (notes.length !== 2) continue;
      if (linked.has(pk(notes[0].path, notes[1].path))) continue; // already a resident path
      out.push({ a: notes[0], b: notes[1], via: { key: node.key, label: node.label } });
    }
    return out.sort(
      (x, y) => x.via.label.localeCompare(y.via.label) || x.a.basename.localeCompare(y.a.basename)
    );
  }

  /** Pick today's door — stable per day (a ritual), cycled by "another". */
  private dailyDoor(): { a: NoteRef; b: NoteRef; via: { key: string; label: string } } | null {
    const pool = this.ripePool();
    if (!pool.length) return null;
    const seed = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let h = 0;
    for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return pool[(h + this._drawOffset) % pool.length];
  }

  private hideDaily(): void {
    this._dailyEl?.setAttr("aria-hidden", "true");
  }

  /** Render the centre "reading" — today's coincidence with act-in-place buttons. */
  private renderDaily(): void {
    const el = this._dailyEl;
    if (!el) return;
    el.empty();
    const door = this.cursor >= 0 || this.keystone ? null : this.dailyDoor();
    if (!door) {
      el.setAttr("aria-hidden", "true");
      return;
    }
    el.setAttr("aria-hidden", "false");
    el.createDiv({ cls: "rg-daily-tag", text: "today's door" });
    const pair = el.createDiv({ cls: "rg-daily-pair" });
    pair.createSpan({ cls: "rg-daily-note", text: trunc(displayLabel(door.a.basename), 24) });
    pair.createSpan({ cls: "rg-daily-join", text: "⟷" });
    pair.createSpan({ cls: "rg-daily-note", text: trunc(displayLabel(door.b.basename), 24) });
    el.createDiv({ cls: "rg-daily-via", text: `joined only by ${displayLabel(door.via.label)}` });
    const acts = el.createDiv({ cls: "rg-daily-acts" });
    const btn = (label: string, primary: boolean, run: () => void): void => {
      const b = acts.createEl("button", { cls: primary ? "rg-daily-btn rg-daily-primary" : "rg-daily-btn", text: label });
      b.addEventListener("click", (e) => (e.stopPropagation(), run()));
    };
    btn("build the stair", true, () => void this.forgePair(door.a.path, door.b.path));
    btn("open " + trunc(displayLabel(door.a.basename), 12), false, () => this.host.openNote(door.a.path));
    btn("open " + trunc(displayLabel(door.b.basename), 12), false, () => this.host.openNote(door.b.path));
    btn("another", false, () => (this._drawOffset++, this.renderDaily()));
  }

  /** Forge an arbitrary pair (today's door) with an Undo Notice; advance to the next door. */
  private async forgePair(a: string, b: string): Promise<void> {
    try {
      await this.host.forge(a, b);
      const n = new Notice(`forged · ${displayLabel(baseOf(a))} ↔ ${displayLabel(baseOf(b))}`, 6000);
      const undo = n.noticeEl.createEl("button", { cls: "rg-undo-btn", text: "undo" });
      undo.addEventListener("click", async () => {
        n.hide();
        await this.host.removeConnection(a, b);
        new Notice("connection removed");
      });
      this._drawOffset++;
      this.renderDaily();
    } catch (e) {
      new Notice("forge failed: " + String((e as Error)?.message ?? e));
    }
  }

  private setKeystone(k: { kind: "note" | "facet"; key: string }): void {
    const same = !!this.keystone && this.keystone.kind === k.kind && this.keystone.key === k.key;
    this.keystone = same ? null : k;
    this.cursor = -1;
    this._noteEls.forEach((g) => g.classList.remove("rg-cursor"));
    this.highlightConnections(null); // reset any hover spotlight before the new state
    if (this.keystone) {
      this.panToCenter();
      if (this.host.animations()) this.arrivalPulse();
    }
    // point the resident graph at the same note — tourist (Rhizone) ↔ resident (Reticular)
    if (this.keystone && this.keystone.kind === "note") this.host.openInScope(this.keystone.key);
    this.layout();
  }
  private release(): void {
    if (!this.keystone) return;
    this.keystone = null;
    this.highlightConnections(null); // drop the spotlight
    this.layout();
  }

  /**
   * The depletion forge: weld the keystone↔kin coincidence into a real connections: edge. It
   * graduates to Reticular (a resident path) and drains out of Rhizone — the kin leaves the inner
   * ring on the next rebuild (which the metadata "changed" event triggers) and becomes a chord.
   */
  private async forgeWith(path: string): Promise<void> {
    const ks = this.keystone;
    if (!ks || ks.kind !== "note") return;
    const ksPath = ks.key;
    this._noteEls.get(path)?.classList.add("rg-graduating"); // felt settle before the rebuild lands
    try {
      await this.host.forge(ksPath, path);
      const n = new Notice(`forged · ${displayLabel(baseOf(ksPath))} ↔ ${displayLabel(baseOf(path))}`, 6000);
      const undo = n.noticeEl.createEl("button", { cls: "rg-undo-btn", text: "undo" });
      undo.addEventListener("click", async () => {
        n.hide();
        await this.host.removeConnection(ksPath, path);
        new Notice("connection removed");
      });
    } catch (e) {
      new Notice("forge failed: " + String((e as Error)?.message ?? e));
    }
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
    this.host.syncScope(note.path); // the resident graph tracks whatever's highlighted
    this.hideDaily(); // roaming → the scan readout takes the centre
    this.updateScanTitle();
  }

  /** Ambient: light a note's chords and reveal the labels of the notes it's connected to. */
  private highlightConnections(path: string | null): void {
    this._linksEl?.querySelectorAll(".rg-link-hot").forEach((el) => el.classList.remove("rg-link-hot"));
    this._noteEls.forEach((g) => g.classList.remove("rg-near", "rg-on"));
    this._ghostEls.forEach((g) => g.classList.remove("rg-near", "rg-on"));
    this.contentEl.removeClass("rg-spotlight");
    if (!path) return; // works in focus too: hover any ring node to light its route
    const at = (k: string): SVGGElement | undefined => this._noteEls.get(k) ?? this._ghostEls.get(k);
    for (const ln of this._linkEls.get(path) ?? []) ln.classList.add("rg-link-hot");
    for (const nb of this._adj.get(path) ?? []) at(nb)?.classList.add("rg-near", "rg-on");
    if (this.keystone) {
      // tree in view → spotlight: dim everything but the hovered node, its neighbours, and the keystone
      this.contentEl.addClass("rg-spotlight");
      at(path)?.classList.add("rg-on");
      if (this.keystone.kind === "note") this._noteEls.get(this.keystone.key)?.classList.add("rg-on");
    }
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
  /** A one-shot ring that expands from the centre when a keystone is summoned. */
  private arrivalPulse(): void {
    if (!this._pan) return;
    const c = this._pan.createSvg("circle", { cls: ["rg-arrival"], attr: { cx: C, cy: C, r: 14 } });
    c.addEventListener("animationend", () => c.remove());
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
      this.layoutGhosts(null);
      this.drawCenter(null);
      this.drawLinks();
      this.hidePanel();
      this.renderDaily(); // the reading fills the empty centre
      return;
    }

    // focused — the keystone's rare-facet kin to the inner ring, the rest dimmed outside
    const baseFacets = ks.kind === "note" ? this.host.noteFacets(ks.key) : [ks.key];
    const ksNote = ks.kind === "note" ? ks.key : null;
    // estrangement: the inner ring is rare kin you HAVEN'T drawn yet — forged/linked pairs have
    // graduated to Reticular and drain out of here (they show as resident chords instead)
    const drawn = new Set(ksNote ? this._adj.get(ksNote) ?? [] : []);
    const related = this.host
      .relatedNotes(baseFacets, ksNote ?? undefined)
      .filter((r) => !drawn.has(r.path))
      .slice(0, INNER_CAP);
    const innerSet = new Set(related.map((r) => r.path));
    this._inner = innerSet;

    // the keystone's unwritten doors — the phantom facets it calls — join the inner ring too
    const ghostKeys = new Set(this._ghosts.map((g) => g.key));
    const ghostKin = (ksNote ? this.host.noteFacets(ksNote) : []).filter((k) => ghostKeys.has(k));
    const innerGhostSet = new Set(ghostKin);

    // outer notes with a direct link/connection into the active set (keystone + inner ring)
    const activeSet = new Set(innerSet);
    if (ksNote) activeSet.add(ksNote);
    const connected = new Set<string>();
    for (const [a, b] of this._links) {
      if (activeSet.has(a) && !activeSet.has(b)) connected.add(b);
      else if (activeSet.has(b) && !activeSet.has(a)) connected.add(a);
    }

    if (ksNote) this.place(ksNote, { x: C, y: C }, { dim: false, related: false, keystone: true });
    // one combined inner ring: note-kin first, then the unwritten ghost-kin
    const innerNotes = related.filter((r) => r.path !== ksNote);
    const innerTotal = innerNotes.length + ghostKin.length;
    innerNotes.forEach((r, i) =>
      this.place(r.path, ringXY(i, innerTotal, R_IN), { dim: false, related: true, keystone: false })
    );
    ghostKin.forEach((k, j) =>
      this.placeGhost(k, ringXY(innerNotes.length + j, innerTotal, R_IN), { dim: false, related: true })
    );
    const rest = ordered.filter((n) => n.path !== ksNote && !innerSet.has(n.path));
    rest.forEach((n, i) => {
      const linked = connected.has(n.path); // tied to the active set → stays lit + labelled
      this.place(n.path, ringXY(i, rest.length, R_OUT), { dim: !linked, related: false, keystone: false, linked });
    });

    this.layoutGhosts(activeSet, innerGhostSet); // ghost-kin sit on the inner ring; the rest hold the edge
    this.drawCenter(ks);
    this.drawLinks();
    this.renderPanel(ks, innerNotes, ghostKin);
    this.hideDaily();
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
    this.fanLabel(g, p);
  }

  /**
   * Lay the ghost (phantom-facet) ring at the outer edge — same placement rules as the note rings.
   * In focus (activeSet given), a ghost whose calling note is in the active set stays lit + named.
   */
  private layoutGhosts(activeSet: Set<string> | null, innerGhosts?: Set<string>): void {
    const focused = activeSet !== null;
    const edge = this._ghosts.filter((gh) => !innerGhosts?.has(gh.key)); // inner ghost-kin placed elsewhere
    edge.forEach((gh, i) => {
      const p = ringXY(i, edge.length, R_GHOST);
      const linked = focused && (this._adj.get(gh.key) ?? []).some((nb) => activeSet!.has(nb));
      this.placeGhost(gh.key, p, { dim: focused && !linked, related: false, linked });
    });
  }

  /** Position a ghost dot (mirror of place() for the _ghostEls map). */
  private placeGhost(key: string, p: { x: number; y: number }, s: { dim: boolean; related: boolean; linked?: boolean }): void {
    const g = this._ghostEls.get(key);
    if (!g) return;
    this._pos.set(key, p); // so chords to the notes that call this ghost can be drawn
    g.setAttribute("transform", `translate(${p.x} ${p.y})`);
    g.classList.toggle("rg-dim", s.dim);
    g.classList.toggle("rg-related", s.related);
    g.classList.toggle("rg-linked", !!s.linked);
    this.fanLabel(g, p);
  }

  /** Fan a node's label outward from the galaxy centre, anchored by its angle. */
  private fanLabel(g: Element, p: { x: number; y: number }): void {
    const label = g.querySelector(".rg-gx-label");
    if (!label) return;
    const dx = p.x - C;
    const dy = p.y - C;
    const len = Math.hypot(dx, dy) || 1;
    const off = DOT + 12;
    label.setAttribute("x", String((dx / len) * off));
    label.setAttribute("y", String((dy / len) * off + 4));
    label.setAttribute("text-anchor", dx > len * 0.3 ? "start" : dx < -len * 0.3 ? "end" : "middle");
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
    const pathsAt = new Map<string, SVGElement[]>(); // Sephira name → the paths touching it
    for (const p of tree.paths) {
      const a = pos.get(p.from);
      const b = pos.get(p.to);
      if (!a || !b) continue;
      const line = grp.createSvg("line", { cls: ["rg-lt-path"], attr: { x1: a.x, y1: a.y, x2: b.x, y2: b.y } });
      line.style.setProperty("--rg-path-strength", String(0.12 + p.affinity * 0.6));
      (pathsAt.get(p.from) ?? pathsAt.set(p.from, []).get(p.from)!).push(line);
      (pathsAt.get(p.to) ?? pathsAt.set(p.to, []).get(p.to)!).push(line);
    }
    let bloom = 0; // bloom stagger index
    for (const gw of tree.gateways) {
      if (!gw.facet) continue;
      const p = pos.get(gw.name)!;
      const node = grp.createSvg("g", { cls: ["rg-lt-node"], attr: { role: "button", "aria-label": gw.facet.label } });
      node.style.setProperty("--rg-delay", `${bloom++ * 45}ms`); // staggered bloom
      node.createSvg("circle", { cls: ["rg-lt-hit"], attr: { cx: p.x, cy: p.y, r: 18 } }); // generous invisible hover target
      node.createSvg("circle", { cls: ["rg-lt-dot"], attr: { cx: p.x, cy: p.y, r: 7 } });
      // fan the label outward from the tree centre so the ten gateways don't stack on each other
      const dx = p.x - C;
      const dy = p.y - C;
      const len = Math.hypot(dx, dy);
      const lx = len < 1 ? p.x : p.x + (dx / len) * 16;
      const ly = len < 1 ? p.y - 14 : p.y + (dy / len) * 16 + 4;
      const anchor = dx > len * 0.25 ? "start" : dx < -len * 0.25 ? "end" : "middle";
      node.createSvg("text", { cls: ["rg-lt-label"], attr: { x: lx, y: ly, "text-anchor": anchor } }).setText(
        trunc(displayLabel(gw.facet.label), 18)
      );
      const key = gw.facet.key;
      const touching = pathsAt.get(gw.name) ?? [];
      node.addEventListener("mouseover", () => {
        touching.forEach((ln) => ln.classList.add("rg-lt-hot"));
        (this._tieEls.get(key) ?? []).forEach((ln) => ln.classList.add("rg-tie-hot")); // ties from inner notes to this facet
      });
      node.addEventListener("mouseout", () => {
        touching.forEach((ln) => ln.classList.remove("rg-lt-hot"));
        (this._tieEls.get(key) ?? []).forEach((ln) => ln.classList.remove("rg-tie-hot"));
      });
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
    this._tieEls.clear();

    // focused: dim every chord but the ones touching the keystone or its inner ring (active here & now)
    const ksNote = this.keystone && this.keystone.kind === "note" ? this.keystone.key : null;
    const active = (p: string): boolean => p === ksNote || this._inner.has(p);
    grp.classList.toggle("rg-focused", !!this.keystone);

    const drawEdge = (a: string, b: string, ghost: boolean): void => {
      const pa = this._pos.get(a);
      const pb = this._pos.get(b);
      if (!pa || !pb) return;
      const cls = ghost ? ["rg-gx-link", "rg-gx-glink"] : ["rg-gx-link"];
      const ln = grp.createSvg("line", { cls, attr: { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y } }) as SVGLineElement;
      (this._linkEls.get(a) ?? this._linkEls.set(a, []).get(a)!).push(ln);
      (this._linkEls.get(b) ?? this._linkEls.set(b, []).get(b)!).push(ln);
      if (this.keystone && (active(a) || active(b))) ln.classList.add("rg-link-active");
    };

    // chords: the vault's note→note links, plus each note→ghost call (a note's unwritten target)
    for (const [a, b] of this._links) drawEdge(a, b, false);
    for (const [a, b] of this._ghostLinks) drawEdge(a, b, true);

    // ties: inner-ring note → each local-tree facet it cites
    if (this.keystone && this._treeFacets.size) {
      for (const path of this._inner) {
        const p = this._pos.get(path);
        if (!p) continue;
        for (const fk of this.host.noteFacets(path)) {
          const tp = this._treeFacets.get(fk);
          if (!tp) continue;
          const ln = grp.createSvg("line", {
            cls: ["rg-gx-tie"],
            attr: { x1: p.x, y1: p.y, x2: tp.x, y2: tp.y, pathLength: "1" } // pathLength=1 → CSS can draw it in
          }) as SVGLineElement;
          (this._tieEls.get(fk) ?? this._tieEls.set(fk, []).get(fk)!).push(ln); // by facet, for gateway hover
          (this._linkEls.get(path) ?? this._linkEls.set(path, []).get(path)!).push(ln); // by note, for note hover
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
