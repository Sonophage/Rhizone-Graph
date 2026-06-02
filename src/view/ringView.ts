import { ItemView, Menu, type WorkspaceLeaf, type TFile, type App, type Component } from "obsidian";
import type { Candidate, LocalWeb, NodeState } from "../engine/types.ts";
import type { PhantomFacet } from "../engine/cocitation.ts";
import { BreadcrumbTrail, installKeyboardNav } from "./interaction.ts";
import { applyRemediation, remediationActions, type RemediationAction } from "./remediation.ts";
import { NotePickerModal } from "./notePicker.ts";

export const RETICULAR_VIEW_TYPE = "reticular-scope";

const VIEW = 700; // SVG viewBox is VIEW×VIEW; CSS scales it to the pane. Tight to the radar (ghosts are a side list now, not a perimeter ring).
const TOP_OUTER = 10;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

const GLYPH: Record<NodeState, string> = { connected: "●", mentioned: "○", candidate: "✦" };
const SECTION_ORDER: NodeState[] = ["candidate", "connected", "mentioned"];
const SECTION_TITLE: Record<NodeState, string> = { candidate: "Candidates", connected: "Connected", mentioned: "Mentioned" };

/** Slider value (0..100) → the zoom level at which a state's labels become visible. */
function zoomFor(sliderValue: number): number {
  return ZOOM_MIN + (sliderValue / 100) * (ZOOM_MAX - ZOOM_MIN);
}

/** What the view needs from the plugin — kept narrow to avoid a circular import. */
export interface ScopeHost {
  app: App;
  getLocalWeb(focusPath: string): LocalWeb;
  /** Direct links/connections among a set of notes (inter-node edges). */
  neighborEdges(paths: string[]): Array<[string, string]>;
  fileForPath(path: string): TFile | null;
  /** Forge a connection between focus and candidate (bidirectional). */
  forge(focusPath: string, candidatePath: string): Promise<void>;
  /** Read a note's body. */
  readBody(path: string): Promise<string>;
  /** The active markdown note's path, or null. */
  activePath(): string | null;
  /** Per-state label zoom thresholds (0..100). */
  labelThresholds(): { connected: number; mentioned: number; candidate: number };
  setLabelThreshold(state: NodeState, value: number): void;
  /** Show node names inside the radar (persisted). */
  graphLabels(): boolean;
  setGraphLabels(on: boolean): void;
  /** The focus note's unresolved/phantom wikilinks (latent connectors). */
  phantomFacets(focusPath: string): PhantomFacet[];
  /** Run the radar's motion, overriding OS reduce-motion (persisted). */
  animations(): boolean;
  setAnimations(on: boolean): void;
  /** Node fan-spread (0..100): how far apart nodes sit within a sector (persisted). */
  spread(): number;
  setSpread(value: number): void;
  /** Temporary diagnostic: index size + focus facet count. */
  debug(focusPath: string): { notes: number; focusFacets: number; focusFound: boolean };
  /** Component to parent rendered-markdown children to (for cleanup). */
  readonly previewOwner: Component;
}

export class ReticularView extends ItemView {
  private host: ScopeHost;
  private trail: BreadcrumbTrail | null = null;
  private focusPath = "";
  private selected = ""; // currently focused contact path
  private showAll = false;
  private pinned = false; // when pinned, ignore active-note changes
  private showControls = false;
  private hidden = new Set<NodeState>(); // legend filters: hide these states
  private vt = { z: 1, tx: 0, ty: 0 }; // pan/zoom transform state
  private _pan: SVGElement | null = null;
  private _svg: SVGElement | null = null;
  private _hiddenCount = 0; // nodes capped out of the zones this render (drives "show +N")
  private _spot: {
    nodeEls: Map<string, SVGElement>;
    spokeEls: Map<string, SVGElement[]>;
    edgeEls: Array<{ a: string; b: string; els: SVGElement[] }>;
    adj: Map<string, Set<string>>;
  } | null = null; // spotlight wiring for hover-dimming
  private _lastScore = 0; // last reticularity shown (so the count-up eases from it)
  private _scoreRaf = 0;
  private _hoverTimer = 0; // debounce for hover → companion inspect
  private _nodeState = new Map<string, NodeState>(); // path → state, for fading a hidden state's edges

  constructor(leaf: WorkspaceLeaf, host: ScopeHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return RETICULAR_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.focusPath ? `Scope · ${baseOf(this.focusPath)}` : "Reticular Graph";
  }
  getIcon(): string {
    return "radar";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("reticular-graph");
    const active = this.host.activePath();
    if (active) this.setFocus(active);
    else this.render();
  }

  /** Point the scope at a note as a fresh exploration root (resets the breadcrumb). */
  setFocus(path: string): void {
    this.focusPath = path;
    this.trail = new BreadcrumbTrail(path);
    this.selected = "";
    this.showAll = false;
    this.vt = { z: 1, tx: 0, ty: 0 };
    this.render();
    this.emitFocus();
  }

  /** Follow the active editor note, unless pinned or already there. */
  followActive(path: string): void {
    if (this.pinned || path === this.focusPath) return;
    this.setFocus(path);
  }

  /** Re-render the current focus in place (e.g. after an external index change). */
  refresh(): void {
    if (this.focusPath) {
      this.render();
      this.emitFocus();
    }
  }

  currentFocus(): string {
    return this.focusPath;
  }

  /** Companion → galaxy: traverse to a note (pushes breadcrumb). */
  goTo(path: string): void {
    this.traverseTo(path);
  }

  /** Companion → galaxy: jump to an existing crumb (truncate), else treat as a new focus. */
  jumpToPath(path: string): void {
    if (this.trail) {
      const i = this.trail.items().indexOf(path);
      if (i >= 0) {
        this.trail.jumpTo(i);
        this.focusPath = this.trail.current();
      } else {
        this.focusPath = path;
        this.trail.push(path);
      }
    } else {
      this.focusPath = path;
      this.trail = new BreadcrumbTrail(path);
    }
    this.selected = "";
    this.showAll = false;
    this.vt = { z: 1, tx: 0, ty: 0 };
    this.render();
    this.emitFocus();
  }

  private emitFocus(): void {
    /* no-op: the companion was removed; the lists live in the Scope panel now */
  }

  private traverseTo(path: string): void {
    this.focusPath = path;
    this.trail?.push(path);
    this.selected = "";
    this.showAll = false;
    this.vt = { z: 1, tx: 0, ty: 0 };
    this.render();
    this.emitFocus();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    if (!this.focusPath) {
      root.createDiv({ cls: "rg-empty", text: "Open a note, then run “Open in Reticular Graph”." });
      return;
    }

    try {
    const web = this.host.getLocalWeb(this.focusPath);

    // ── bezel header + breadcrumb ──────────────────────────────────────────
    const header = root.createDiv({ cls: "rg-bezel" });
    header.createSpan({ cls: "rg-bezel-tag", text: "RETICULAR" });
    header.createSpan({ cls: "rg-bezel-title", text: baseOf(this.focusPath) });
    const pin = header.createSpan({
      cls: "rg-pin" + (this.pinned ? " is-pinned" : ""),
      text: this.pinned ? "pinned" : "follow",
      attr: { role: "button", tabindex: "0", "aria-label": this.pinned ? "Pinned — click to follow active note" : "Following active note — click to pin" }
    });
    pin.onClickEvent(() => {
      this.pinned = !this.pinned;
      const active = this.host.activePath();
      if (!this.pinned && active && active !== this.focusPath) this.setFocus(active);
      else this.render();
    });
    const gear = header.createSpan({
      cls: "rg-gear" + (this.showControls ? " is-open" : ""),
      text: "⚙",
      attr: { role: "button", tabindex: "0", "aria-label": "Settings" }
    });
    gear.onClickEvent(() => {
      this.showControls = !this.showControls;
      this.render();
    });
    // breadcrumb track — the path you've walked (click a crumb to jump back)
    if (this.trail && this.trail.items().length > 1) {
      const track = root.createDiv({ cls: "rg-note-track" });
      track.createSpan({ cls: "rg-note-track-label", text: "track:" });
      this.trail.items().forEach((p, i, arr) => {
        const crumb = track.createSpan({ cls: "rg-note-crumb", text: baseOf(p) });
        crumb.onClickEvent(() => this.jumpToPath(p));
        if (i < arr.length - 1) track.createSpan({ cls: "rg-note-crumb-sep", text: " › " });
      });
    }

    // ── stage: radar on the left, the connection lists on the right ──────
    const stage = root.createDiv({ cls: "rg-stage" });
    const graphCol = stage.createDiv({ cls: "rg-graph" });
    const svg = graphCol.createSvg("svg", {
      cls: "rg-galaxy",
      attr: { viewBox: `0 0 ${VIEW} ${VIEW}`, role: "group", "aria-label": `Connections for ${baseOf(this.focusPath)}` }
    });
    const pan = svg.createSvg("g", { cls: "rg-pan" }); // pan/zoom transform applied here
    this._svg = svg;
    this._pan = pan;
    const cx = VIEW / 2;
    const cy = VIEW / 2;
    // pin the sweep-arm + ring-bloom rotation to the true centre (in view-box units), whatever VIEW is
    svg.style.setProperty("--rg-origin", `${cx}px ${cy}px`);

    // ── RADAR: four directional sectors around the focus; radial distance = connection strength ──
    // legend filters drop a whole state; direction picks the sector, strength sets the radius
    // (rarest/strongest pulled inward). Concentric rings give the scale; spokes are hued by kind.
    const vis = (arr: Candidate[], state: NodeState): Candidate[] => (this.hidden.has(state) ? [] : arr);
    const connected = vis(web.inner.filter((c) => c.state === "connected"), "connected");
    const mentioned = vis(web.inner.filter((c) => c.state === "mentioned"), "mentioned");
    const linked = [...connected, ...mentioned];
    const candAll = this.hidden.has("candidate") ? [] : web.outer;

    const outboundOnly = linked.filter((c) => c.outbound && !c.inbound);
    const inboundOnly = linked.filter((c) => c.inbound && !c.outbound);
    const mutual = linked.filter((c) => c.outbound && c.inbound);

    const SECTOR_CAP = 14;
    const cap = (arr: Candidate[], n: number): Candidate[] => (this.showAll ? arr : arr.slice(0, n));
    const zOut = cap(outboundOnly, SECTOR_CAP);
    const zIn = cap(inboundOnly, SECTOR_CAP);
    const zMut = cap(mutual, SECTOR_CAP);
    const zCand = cap(candAll, SECTOR_CAP);
    this._hiddenCount =
      outboundOnly.length - zOut.length +
      (inboundOnly.length - zIn.length) +
      (mutual.length - zMut.length) +
      (candAll.length - zCand.length);
    const total = zOut.length + zIn.length + zMut.length + zCand.length;
    // ghost notes — phantom (uncreated) wikilinks this note makes; their own sector on the rim
    const ghosts = this.host.phantomFacets(this.focusPath).slice(0, 50);

    // motion master switch (overrides OS reduce-motion) + hide node names if labels are off
    this.contentEl.toggleClass("rg-anim", this.host.animations());
    svg.toggleClass("rg-no-labels", !this.host.graphLabels());

    // concentric range-rings (radar grid) + faint cardinal axes
    const RINGS = [80, 128, 176, 224];
    const R_IN = 72;
    const R_OUT = RINGS[RINGS.length - 1];
    for (const rr of RINGS) pan.createSvg("circle", { cls: "rg-ring", attr: { cx, cy, r: rr } });
    for (const a of [-Math.PI / 2, Math.PI / 2, Math.PI, 0]) {
      pan.createSvg("line", { cls: "rg-axis", attr: { x1: cx, y1: cy, x2: cx + Math.cos(a) * R_OUT, y2: cy + Math.sin(a) * R_OUT } });
    }
    // idle radar sweep arm (rotates via CSS around the centre)
    pan.createSvg("line", { cls: "rg-sweep", attr: { x1: cx, y1: cy, x2: cx, y2: cy - R_OUT } });

    // strength → radius (strongest inward), scored across everything shown
    const allShown = [...zOut, ...zIn, ...zMut, ...zCand];
    const strength = (c: Candidate): number =>
      (c.state === "connected" ? 2 : c.state === "mentioned" ? 1 : 0) + c.weight;
    const sMin = allShown.reduce((m, c) => Math.min(m, strength(c)), Infinity);
    const sMax = allShown.reduce((m, c) => Math.max(m, strength(c)), -Infinity);
    const radiusFor = (c: Candidate): number => {
      const t = sMax > sMin ? (strength(c) - sMin) / (sMax - sMin) : 0.5; // 1 = strongest
      const raw = R_OUT - t * (R_OUT - R_IN);
      // snap onto the nearest range-ring so every node sits ON a circle, not floating between
      return RINGS.reduce((best, r) => (Math.abs(r - raw) < Math.abs(best - raw) ? r : best), RINGS[0]);
    };

    // place each sector: angle fanned across the sector, radius by strength
    const placed: Array<{ c: Candidate; x: number; y: number; ang: number }> = [];
    const sector = (items: Candidate[], cardinal: number, half: number): void => {
      items.forEach((c, i) => {
        const t = items.length <= 1 ? 0 : (i / (items.length - 1)) * 2 - 1; // -1..1 fan
        const ang = cardinal + half * t;
        const r = radiusFor(c);
        placed.push({ c, x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r, ang });
      });
    };
    const sf = 0.5 + this.host.spread() / 100; // 0..100 → 0.5..1.5 fan-spread factor
    sector(zOut, -Math.PI / 2, 0.52 * sf); // up
    sector(zIn, Math.PI / 2, 0.52 * sf); // down
    sector(zCand, Math.PI, 0.72 * sf); // left — the busy list gets the open side + a wider fan
    sector(zMut, 0, 0.46 * sf); // right — mutual (usually the smallest set) takes the narrower side

    // per-axis count badges near the centre + faint sector labels at the rim
    const axisText = (cls: string, label: string, cardinal: number, rad: number, dy = 0): void => {
      pan
        .createSvg("text", { cls: cls.split(" "), attr: { x: cx + Math.cos(cardinal) * rad, y: cy + Math.sin(cardinal) * rad + dy, "text-anchor": "middle" } })
        .setText(label);
    };
    const HEAD = R_OUT + 20;
    const cardinals: Array<[Candidate[], string, number]> = [
      [outboundOnly, "OUTBOUND", -Math.PI / 2],
      [inboundOnly, "INBOUND", Math.PI / 2],
      [candAll, "CANDIDATES", Math.PI],
      [mutual, "MUTUAL", 0]
    ];
    for (const [arr, label, cardinal] of cardinals) {
      if (!arr.length) continue;
      axisText("rg-zone-label", label, cardinal, HEAD, 4);
      axisText("rg-count-badge", String(arr.length), cardinal, 44, 4);
    }

    // capture element refs + adjacency so hovering a node can spotlight its own connections
    const nodeEls = new Map<string, SVGElement>();
    const spokeEls = new Map<string, SVGElement[]>();
    const edgeEls: Array<{ a: string; b: string; els: SVGElement[] }> = [];
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
      (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    };

    // 1. spokes from the focus core to each node — faint base + signal pulse, hue by kind
    const pos = new Map<string, { x: number; y: number }>();
    this._nodeState.clear();
    for (const { c, x, y } of placed) {
      if (c.path) {
        pos.set(c.path, { x, y });
        this._nodeState.set(c.path, c.state);
      }
      // inbound-only links pulse INWARD (node → focus); everything else pulses outward
      const dir = c.inbound && !c.outbound ? "rg-dir-in" : "";
      const els = signalLine(pan, cx, cy, x, y, "rg-rel", `rg-${c.state}`, dir);
      if (c.path) spokeEls.set(c.path, els);
    }

    // 2. inter-node links — how the neighbours connect to EACH OTHER
    for (const [a, b] of this.host.neighborEdges([...pos.keys()])) {
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (!pa || !pb) continue;
      edgeEls.push({ a, b, els: signalLine(pan, pa.x, pa.y, pb.x, pb.y, "rg-link") });
      link(a, b);
      link(b, a);
    }

    // 3. nodes on top — staggered entrance delay per node
    placed.forEach(({ c, x, y, ang }, i) => {
      const g = this.drawStar(pan, c, x, y, ang);
      g.style.setProperty("--rg-delay", `${Math.min(i, 26) * 22}ms`);
      if (c.path) nodeEls.set(c.path, g);
    });
    this._spot = { nodeEls, spokeEls, edgeEls, adj };

    // ── focus core + reticularity score (★) — rarity-weighted richness of this note's own web ──
    const scored = [...web.inner, ...web.outer];
    const retRaw = scored.reduce(
      (s, c) => s + c.weight + (c.state === "connected" ? 0.5 : c.state === "mentioned" ? 0.25 : 0),
      0
    );
    const reticularity = Math.round(retRaw * 10);
    pan.createSvg("circle", { cls: "rg-core-disc", attr: { cx, cy, r: 34 } });
    const scoreEl = pan.createSvg("text", { cls: "rg-score", attr: { x: cx, y: cy + 8, "text-anchor": "middle" } });
    this.tweenScore(scoreEl, reticularity);

    // ── bottom-right: how influential this note is to the vault ──────────────
    // A composite, not just a backlink count: notes that cite it (direct dependents) weigh most,
    // reciprocal (mutual) ties add a bonus, and its co-citation REACH (how many notes it could
    // connect through shared facets) adds latent pull. Bucketed into 5 colour-coded levels.
    const cites = web.inner.filter((c) => c.inbound).length; // notes that link/connect TO this one
    const mutualTies = web.inner.filter((c) => c.inbound && c.outbound).length;
    const reach = web.outer.length; // co-citation reach — its latent gravitational field
    const infScore = cites * 4 + mutualTies * 2 + Math.round(reach * 0.25);
    const infLevel = infScore >= 31 ? 4 : infScore >= 17 ? 3 : infScore >= 8 ? 2 : infScore >= 1 ? 1 : 0;
    const INF_NAME = ["DORMANT", "MINOR", "NOTABLE", "MAJOR", "CORE"];
    if (total > 0) {
      const infBox = graphCol.createDiv({ cls: `rg-influence rg-inf-${infLevel}` });
      infBox.createSpan({ cls: "rg-influence-label", text: "VAULT INFLUENCE" });
      infBox.createSpan({
        cls: "rg-influence-val",
        text: INF_NAME[infLevel],
        attr: { title: `influence ${infScore} — ${cites} cite it · ${mutualTies} mutual · ${reach} co-cite` }
      });
    }

    // ── connection lists panel (Candidates / Connected / Mentioned / Ghost) beside the radar ──
    this.renderPanel(stage, web, ghosts);

    if (total === 0) {
      const d = this.host.debug(this.focusPath);
      pan
        .createSvg("text", { cls: "rg-scope-empty", attr: { x: cx, y: cy + 44, "text-anchor": "middle" } })
        .setText("no links or shared facets yet");
      pan
        .createSvg("text", { cls: "rg-scope-empty", attr: { x: cx, y: cy + 66, "text-anchor": "middle" } })
        .setText(`diag — index:${d.notes} facets:${d.focusFacets} found:${d.focusFound}`);
    }

    this.attachPanZoom(svg);
    this.applyView();

    // ── legend = clickable filters (click a state to hide/show it) ─────────
    const legend = root.createDiv({ cls: "rg-legend" });
    (["connected", "mentioned", "candidate"] as NodeState[]).forEach((s) => {
      const item = legend.createSpan({
        cls: `rg-legend-item rg-${s}` + (this.hidden.has(s) ? " is-hidden" : ""),
        attr: { role: "button", "aria-label": `Toggle ${s} visibility` }
      });
      item.createSpan({ cls: "rg-glyph", text: GLYPH[s] });
      item.createSpan({ text: " " + s });
      item.onClickEvent(() => {
        const hiding = !this.hidden.has(s);
        if (hiding) this.hidden.add(s);
        else this.hidden.delete(s);
        item.toggleClass("is-hidden", hiding);
        // hiding fades just this state's nodes + lines out and leaves everything else put;
        // showing needs a full render to bring them back (and re-spread the sector)
        if (hiding) {
          this.fadeOut(`.rg-star.rg-${s}, .rg-rel-base.rg-${s}, .rg-rel-pulse.rg-${s}`);
          this.fadeHiddenEdges(s); // also fade the inter-node edges touching those nodes
        } else this.render();
      });
    });
    if (this._hiddenCount > 0 && !this.showAll) {
      const more = legend.createSpan({ cls: "rg-more", text: `show +${this._hiddenCount}` });
      more.onClickEvent(() => {
        this.showAll = true;
        this.render();
      });
    }

    // ── readout + preview (below the legend; scrolls without covering it) ───
    const readout = root.createDiv({ cls: "rg-readout", attr: { "aria-live": "polite" } });

    // keyboard: Tab cycles contacts, Enter traverse, F forge, Esc back
    installKeyboardNav(svg, {
      traverse: () => this.selected && this.traverseTo(this.selected),
      forge: () => void this.forgeSelected(),
      back: () => {
        if (this.trail) {
          this.focusPath = this.trail.back();
          this.render();
          this.emitFocus();
        }
      }
    });

    this.renderReadout(readout, null);
    this._readoutEl = readout;

    if (this.showControls) this.renderControls(root);
    } catch (e) {
      root.createDiv({ cls: "rg-error" }).setText("Reticular Graph render error:\n" + String((e as Error)?.stack ?? e));
    }
  }

  private _readoutEl: HTMLElement | null = null;

  /** Apply the current pan/zoom transform and toggle per-state label visibility by zoom. */
  private applyView(): void {
    if (!this._pan || !this._svg) return;
    this._pan.setAttribute("transform", `translate(${this.vt.tx} ${this.vt.ty}) scale(${this.vt.z})`);
    const t = this.host.labelThresholds();
    this._svg.toggleClass("rg-lab-connected", this.vt.z >= zoomFor(t.connected));
    this._svg.toggleClass("rg-lab-mentioned", this.vt.z >= zoomFor(t.mentioned));
    this._svg.toggleClass("rg-lab-candidate", this.vt.z >= zoomFor(t.candidate));
  }

  private attachPanZoom(svg: SVGElement): void {
    svg.addEventListener(
      "wheel",
      (ev: WheelEvent) => {
        ev.preventDefault();
        const rect = svg.getBoundingClientRect();
        const px = ((ev.clientX - rect.left) / rect.width) * VIEW;
        const py = ((ev.clientY - rect.top) / rect.height) * VIEW;
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.vt.z * factor));
        const k = nz / this.vt.z;
        this.vt.tx = px - (px - this.vt.tx) * k;
        this.vt.ty = py - (py - this.vt.ty) * k;
        this.vt.z = nz;
        this.applyView();
      },
      { passive: false }
    );

    let dragging = false;
    let lx = 0;
    let ly = 0;
    svg.addEventListener("pointerdown", (ev: PointerEvent) => {
      if ((ev.target as Element).closest("[data-rg-contact]")) return; // let stars handle their own clicks
      dragging = true;
      lx = ev.clientX;
      ly = ev.clientY;
      svg.addClass("rg-grabbing");
    });
    svg.addEventListener("pointermove", (ev: PointerEvent) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const s = VIEW / rect.width;
      this.vt.tx += (ev.clientX - lx) * s;
      this.vt.ty += (ev.clientY - ly) * s;
      lx = ev.clientX;
      ly = ev.clientY;
      this.applyView();
    });
    const end = (): void => {
      dragging = false;
      svg.removeClass("rg-grabbing");
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointerleave", end);
  }

  private renderControls(root: HTMLElement): void {
    const panel = root.createDiv({ cls: "rg-controls" });
    panel.createDiv({ cls: "rg-controls-title", text: "SETTINGS" });
    const lblRow = panel.createDiv({ cls: "rg-control-row" });
    const lblBox = lblRow.createEl("input", { cls: "rg-toggle", attr: { type: "checkbox" } });
    lblBox.checked = this.host.graphLabels();
    lblRow.createSpan({ cls: "rg-control-label", text: "Labels in graph" });
    lblBox.addEventListener("change", () => {
      this.host.setGraphLabels(lblBox.checked);
      this._svg?.toggleClass("rg-no-labels", !lblBox.checked); // live, no full re-render
    });
    const animRow = panel.createDiv({ cls: "rg-control-row" });
    const animBox = animRow.createEl("input", { cls: "rg-toggle", attr: { type: "checkbox" } });
    animBox.checked = this.host.animations();
    animRow.createSpan({ cls: "rg-control-label", text: "Animations" });
    animBox.addEventListener("change", () => {
      this.host.setAnimations(animBox.checked);
      this.render(); // re-render so entrance + motion gating take effect
    });
    const spreadRow = panel.createDiv({ cls: "rg-control-row" });
    spreadRow.createSpan({ cls: "rg-control-label", text: "Node spread" });
    const spreadInput = spreadRow.createEl("input", {
      cls: "rg-slider",
      attr: { type: "range", min: "0", max: "100", value: String(this.host.spread()) }
    });
    // re-render on release (not during drag) so the slider element isn't rebuilt mid-drag
    spreadInput.addEventListener("change", () => {
      this.host.setSpread(Number(spreadInput.value));
      this.render();
    });

    const reset = panel.createDiv({ cls: "rg-control-row" });
    const btn = reset.createSpan({ cls: "rg-reset-view", text: "reset view", attr: { role: "button" } });
    btn.onClickEvent(() => {
      this.vt = { z: 1, tx: 0, ty: 0 };
      this.applyView();
    });
  }

  /** One node on the radar: icon (state shape) + the note name set just OUTWARD from the dot (so it
   *  reads away from the centre). Generous hit target; click inspects, double-click re-centres. */
  /** A ghost note — a phantom (uncreated) wikilink. Faint, non-traversable; shows its reach. */
  /**
   * Graceful hide: fade ONLY the elements matching `selector` to transparent, then drop them —
   * the rest of the radar stays exactly where it is (no full re-render, no reflow flash).
   */
  private fadeOut(selector: string): void {
    this.fadeEls(this._svg ? Array.from(this._svg.querySelectorAll(selector)) : []);
  }

  /** Fade the inter-node (cyan) edges touching any node of a hidden state, so none dangle. */
  private fadeHiddenEdges(state: NodeState): void {
    if (!this._spot) return;
    const els: Element[] = [];
    for (const e of this._spot.edgeEls) {
      if (this._nodeState.get(e.a) === state || this._nodeState.get(e.b) === state) els.push(...e.els);
    }
    this.fadeEls(els);
  }

  private fadeEls(els: Element[]): void {
    if (!els.length) return;
    if (!this.host.animations()) {
      els.forEach((el) => el.remove());
      return;
    }
    els.forEach((el) => el.classList.add("rg-leaving"));
    window.setTimeout(() => els.forEach((el) => el.remove()), 300);
  }

  private drawStar(svg: SVGElement, c: Candidate, x: number, y: number, ang: number): SVGElement {
    const g = svg.createSvg("g", {
      cls: c.dangling ? ["rg-star", `rg-${c.state}`, "rg-dangling"] : ["rg-star", `rg-${c.state}`],
      attr: { "data-rg-contact": "1", "data-path": c.path, tabindex: "0", role: "button", "aria-label": ariaFor(c) }
    });
    // generous transparent hit target — easy to land on, esp. touch
    g.createSvg("circle", { cls: "rg-hit", attr: { cx: x, cy: y, r: 15 } });
    // ping ring — only animates while this node is the hovered one
    g.createSvg("circle", { cls: "rg-ping", attr: { cx: x, cy: y, r: 9 } });
    if (c.dangling) {
      g.createSvg("text", { cls: "rg-star-warn", attr: { x, y: y + 5, "text-anchor": "middle" } }).setText("⚠");
    } else if (c.state === "candidate") {
      g.createSvg("path", { cls: "rg-star-dot", attr: { d: sparkle(x, y, 7, 2.5) } });
    } else {
      g.createSvg("circle", { cls: "rg-star-dot", attr: { cx: x, cy: y, r: c.state === "connected" ? 6 : 5.5 } });
    }
    // name set outward along the radius; right side reads icon→text, left side mirrors
    const ox = Math.cos(ang);
    const oy = Math.sin(ang);
    const anchor = ox > 0.25 ? "start" : ox < -0.25 ? "end" : "middle";
    g.createSvg("text", {
      cls: "rg-star-label",
      attr: { x: x + ox * 12, y: y + oy * 12 + 4, "text-anchor": anchor }
    }).setText(clip(c.basename, ox > 0.25 ? 16 : 18));

    const select = () => {
      this.selected = c.path;
      if (this._readoutEl) this.renderReadout(this._readoutEl, c);
    };
    g.addEventListener("mouseenter", () => {
      select();
      if (!c.dangling && c.path) {
        this.highlight(c.path, true); // spotlight this node + its connections
        this.hoverInspect(c); // and reflect it in the companion panel
      }
    });
    g.addEventListener("mouseleave", () => {
      if (!c.dangling && c.path) this.highlight(c.path, false);
      this.revertInspect();
    });
    g.addEventListener("focus", select);
    // native Page Preview popover on hover (no-op if the core plugin is off)
    if (!c.dangling) {
      g.addEventListener("mouseover", (ev) => {
        this.host.app.workspace.trigger("hover-link", {
          event: ev,
          source: "reticular-graph",
          hoverParent: this,
          targetEl: g,
          linktext: c.basename,
          sourcePath: this.focusPath
        });
      });
    }
    // click → re-centre here + open the note in the editor (dangling → remediation menu)
    g.addEventListener("click", (ev) => {
      if (c.dangling) this.openRemediation(c.basename, ev);
      else this.activate(c);
    });
    return g;
  }

  /** Count the centre score up (or down) to its new value; eased, cancellable, motion-gated. */
  private tweenScore(el: SVGElement, to: number): void {
    if (this._scoreRaf) cancelAnimationFrame(this._scoreRaf);
    if (!this.host.animations()) {
      el.setText(String(to));
      this._lastScore = to;
      return;
    }
    const from = this._lastScore;
    const dur = 650;
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.setText(String(Math.round(from + (to - from) * eased)));
      if (t < 1) this._scoreRaf = requestAnimationFrame(step);
      else {
        this._lastScore = to;
        this._scoreRaf = 0;
      }
    };
    this._scoreRaf = requestAnimationFrame(step);
  }

  /** Push a node into the companion panel without re-rooting the scope (hover inspect). */
  private inspect(c: Candidate): void {
    this.selected = c.path;
    if (this._readoutEl) this.renderReadout(this._readoutEl, c);
  }

  /** The connection lists beside the radar: Candidates / Connected / Mentioned / Ghost. */
  private renderPanel(stage: HTMLElement, web: LocalWeb, ghosts: PhantomFacet[]): void {
    const panel = stage.createDiv({ cls: "rg-panel" });
    const counts = panel.createDiv({ cls: "rg-note-counts" });
    const byState: Record<NodeState, Candidate[]> = {
      candidate: web.outer,
      connected: web.inner.filter((c) => c.state === "connected"),
      mentioned: web.inner.filter((c) => c.state === "mentioned")
    };
    const sections: Array<{ key: string; glyph: string; label: string; count: number; el: HTMLDetailsElement }> = [];
    for (const state of SECTION_ORDER) {
      sections.push({
        key: state,
        glyph: GLYPH[state],
        label: SECTION_TITLE[state].toLowerCase(),
        count: byState[state].length,
        el: this.renderListSection(panel, state, byState[state])
      });
    }
    sections.push({ key: "ghost", glyph: "◌", label: "ghost notes", count: ghosts.length, el: this.renderGhostList(panel, ghosts) });

    for (const s of sections) {
      const chip = counts.createSpan({ cls: `rg-count rg-${s.key}`, attr: { role: "button" } });
      chip.createSpan({ cls: `rg-glyph rg-${s.key}`, text: s.glyph });
      chip.createSpan({ text: ` ${s.count} ${s.label}` });
      chip.onClickEvent(() => {
        s.el.open = !s.el.open;
        chip.toggleClass("is-open", s.el.open);
        if (s.el.open) s.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }

  private renderListSection(parent: HTMLElement, state: NodeState, items: Candidate[]): HTMLDetailsElement {
    const sec = parent.createEl("details", { cls: `rg-note-section rg-${state}` });
    sec.open = false;
    const title = sec.createEl("summary", { cls: "rg-note-section-title" });
    title.createSpan({ cls: `rg-glyph rg-${state}`, text: GLYPH[state] });
    title.createSpan({ text: ` ${SECTION_TITLE[state]} (${items.length})` });
    if (!items.length) {
      sec.createDiv({ cls: "rg-note-section-empty", text: "—" });
      return sec;
    }
    for (const c of items) {
      const row = sec.createDiv({ cls: "rg-note-row" + (c.dangling ? " rg-dangling" : "") });
      const name = row.createSpan({ cls: "rg-note-row-name", text: (c.dangling ? "⚠ " : "") + c.basename });
      if (c.dangling) {
        name.onClickEvent((ev) => this.openRemediation(c.basename, ev));
      } else if (c.path) {
        name.onClickEvent(() => this.activate(c)); // re-centre + open in editor
        row.addEventListener("mouseenter", () => this.highlight(c.path, true));
        row.addEventListener("mouseleave", () => this.highlight(c.path, false));
        row.addEventListener("mouseover", (ev) => this.hoverLink(ev, row, c.basename));
      }
      if (c.shared.length) {
        const why = row.createSpan({ cls: "rg-note-why" });
        why.createSpan({ cls: "rg-note-why-label", text: "WHY " });
        why.createSpan({ cls: "rg-note-why-facets", text: c.shared.slice(0, 4).map((f) => f.label).join(" · ") });
      }
      if (state === "candidate" && !c.dangling) {
        const forge = row.createSpan({ cls: "rg-note-designate", text: "designate", attr: { role: "button" } });
        forge.onClickEvent(async () => {
          await this.host.forge(this.focusPath, c.path);
          this.render(); // re-render so the candidate moves to Connected, live
        });
      }
    }
    return sec;
  }

  private renderGhostList(parent: HTMLElement, ghosts: PhantomFacet[]): HTMLDetailsElement {
    const sec = parent.createEl("details", { cls: "rg-note-section rg-ghost" });
    sec.open = false;
    const title = sec.createEl("summary", { cls: "rg-note-section-title" });
    title.createSpan({ cls: "rg-glyph rg-ghost", text: "◌" });
    title.createSpan({ text: ` Ghost notes (${ghosts.length})` });
    if (!ghosts.length) {
      sec.createDiv({ cls: "rg-note-section-empty", text: "—" });
      return sec;
    }
    for (const g of ghosts) {
      const row = sec.createDiv({ cls: "rg-note-row rg-phantom-row" });
      row.createSpan({ cls: "rg-note-row-name", text: "◌ " + g.label });
      row.createSpan({ cls: "rg-note-why", text: g.shared > 1 ? `${g.shared} notes mention this` : "only here" });
    }
    return sec;
  }

  /** Obsidian's native page-preview popover near `el` (needs core Page Preview enabled). */
  private hoverLink(ev: MouseEvent, el: HTMLElement, basename: string): void {
    this.host.app.workspace.trigger("hover-link", {
      event: ev,
      source: "reticular-graph",
      hoverParent: this,
      targetEl: el,
      linktext: basename,
      sourcePath: this.focusPath
    });
  }

  /** Debounced hover → companion, so sweeping the cursor across rows doesn't thrash the panel. */
  private hoverInspect(c: Candidate): void {
    window.clearTimeout(this._hoverTimer);
    if (c.dangling || !c.path) return;
    this._hoverTimer = window.setTimeout(() => this.inspect(c), 110);
  }

  /** Pointer left a node/row — fall back to the focused (main) note in the companion. */
  private revertInspect(): void {
    window.clearTimeout(this._hoverTimer);
    this._hoverTimer = window.setTimeout(() => this.emitFocus(), 160);
  }

  /** Click → make this note the new centre AND open it in the editor. */
  private activate(c: Candidate): void {
    if (c.dangling || !c.path) return;
    window.clearTimeout(this._hoverTimer);
    this.host.app.workspace.openLinkText(c.basename, this.focusPath); // open in the editor
    this.traverseTo(c.path); // re-centre the scope here (re-renders + syncs the companion)
  }

  /** Spotlight: dim the whole graph except `path`, the focus core, and the connections `path` has. */
  private highlight(path: string, on: boolean): void {
    if (!this._svg || !this._spot) return;
    const { nodeEls, spokeEls, edgeEls, adj } = this._spot;
    const clear = (): void => {
      nodeEls.forEach((g) => g.classList.remove("rg-on", "rg-hovered"));
      spokeEls.forEach((els) => els.forEach((e) => e.classList.remove("rg-on")));
      edgeEls.forEach(({ els }) => els.forEach((e) => e.classList.remove("rg-on")));
    };
    if (!on) {
      this._svg.removeClass("rg-spotlight");
      clear();
      return;
    }
    this._svg.addClass("rg-spotlight");
    clear();
    const keep = new Set<string>([path, ...(adj.get(path) ?? [])]); // the node + its neighbours
    nodeEls.forEach((g, p) => g.classList.toggle("rg-on", keep.has(p)));
    nodeEls.get(path)?.classList.add("rg-hovered"); // the hovered node gets the ping
    spokeEls.get(path)?.forEach((e) => e.classList.add("rg-on")); // its spoke to the focus
    for (const { a, b, els } of edgeEls) {
      if (a === path || b === path) els.forEach((e) => e.classList.add("rg-on")); // its inter-node links
    }
  }


  private renderReadout(el: HTMLElement, c: Candidate | null): void {
    el.empty();
    if (!c) {
      el.createSpan({ cls: "rg-readout-hint", text: "hover → preview in panel · click → open + re-centre · F designate · scroll zoom · drag pan" });
      return;
    }
    el.createSpan({ cls: "rg-readout-kind", text: "CONTACT" });
    el.createSpan({ cls: "rg-readout-name", text: ` · ${c.basename}` });
    if (c.shared.length) {
      el.createSpan({ cls: "rg-readout-why", text: " — shared: " + c.shared.map((f) => f.label).join(" · ") });
    }
    if (c.state === "candidate") {
      const forge = el.createSpan({ cls: "rg-designate", text: " [ designate ↵ ]" });
      forge.onClickEvent(() => void this.forgeSelected());
    }
  }

  private openRemediation(oldTarget: string, ev: MouseEvent): void {
    const titles: Record<RemediationAction, string> = {
      reconnect: "Reconnect to moved note…",
      repoint: "Repoint to another note…",
      delete: "Delete connection"
    };
    const menu = new Menu();
    for (const action of remediationActions(true)) {
      menu.addItem((item) =>
        item.setTitle(titles[action]).onClick(() => {
          if (action === "delete") {
            void applyRemediation(this.host, this.focusPath, action, oldTarget).then(() => this.render());
          } else {
            new NotePickerModal(this.host.app, (f) => {
              void applyRemediation(this.host, this.focusPath, action, oldTarget, f).then(() => this.render());
            }).open();
          }
        })
      );
    }
    menu.showAtMouseEvent(ev);
  }

  private async forgeSelected(): Promise<void> {
    if (!this.selected || !this.focusPath) return;
    await this.host.forge(this.focusPath, this.selected);
    this.refresh(); // re-render + push the updated web to the companion
  }
}

// ── tiny SVG helpers ───────────────────────────────────────────────────────
function line(svg: SVGElement, x1: number, y1: number, x2: number, y2: number, cls: string | string[]): SVGElement {
  return svg.createSvg("line", { cls, attr: { x1, y1, x2, y2 } });
}

/** A faint static base + a traveling "signal" pulse on top (Cartograph-style firing). Returns [base, pulse]. */
function signalLine(svg: SVGElement, x1: number, y1: number, x2: number, y2: number, kind: string, stateCls?: string, extraCls?: string): SVGElement[] {
  const base = [`${kind}-base`];
  const pulse = [`${kind}-pulse`];
  if (stateCls) {
    base.push(stateCls);
    pulse.push(stateCls);
  }
  if (extraCls) pulse.push(extraCls); // e.g. rg-dir-in → reverses the pulse travel
  return [line(svg, x1, y1, x2, y2, base), line(svg, x1, y1, x2, y2, pulse)];
}
/** A 4-point sparkle path (candidate star) centred at (x,y). */
function sparkle(x: number, y: number, ro: number, ri: number): string {
  return `M ${x} ${y - ro} L ${x + ri} ${y - ri} L ${x + ro} ${y} L ${x + ri} ${y + ri} L ${x} ${y + ro} L ${x - ri} ${y + ri} L ${x - ro} ${y} L ${x - ri} ${y - ri} Z`;
}
/** Upward equilateral triangle centred on (x,y), `s` = half-width. */
function triangle(x: number, y: number, s: number): string {
  const h = s * 0.95;
  return `M ${x} ${y - h} L ${x + s} ${y + h * 0.78} L ${x - s} ${y + h * 0.78} Z`;
}
function ariaFor(c: Candidate): string {
  const why = c.shared.length ? `; shared: ${c.shared.map((f) => f.label).join(", ")}` : "";
  return `${c.basename} — ${c.state}${why}`;
}
function baseOf(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/i, "");
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
