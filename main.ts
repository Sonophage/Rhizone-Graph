import { MarkdownView, Plugin, TFile, debounce, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import { FacetIndex } from "./src/engine/index.ts";
import { buildLocalWeb, neighborEdges, phantomFacets, type PhantomFacet } from "./src/engine/cocitation.ts";
import type { LocalWeb, NodeState } from "./src/engine/types.ts";
import { buildRecords, recordFromCache } from "./src/obsidian/adapter.ts";
import { forge } from "./src/obsidian/connections.ts";
import { buildTree as computeTree, type Tree } from "./src/engine/tree.ts";
import { buildFacetGraph, detectCommunities, isContentTitle, type FacetGraph } from "./src/engine/facetGraph.ts";
import { ReticularView, RETICULAR_VIEW_TYPE, type ScopeHost } from "./src/view/ringView.ts";
import { RhizoneFacetView, RHIZONE_FACET_VIEW_TYPE, type RhizoneHost } from "./src/view/rhizoneView.ts";

interface RGSettings {
  /** per-state label zoom thresholds, 0 (always) .. 100 (only when fully zoomed in) */
  labelZoom: { connected: number; mentioned: number; candidate: number };
  /** show node names inside the radar */
  graphLabels: boolean;
  /** run the radar's motion (pulses, twinkle, entrance, sweep) — overrides the OS reduce-motion gate */
  animations: boolean;
  /** node fan-spread within a sector, 0 (tight) .. 100 (wide); 50 = default */
  spread: number;
}
const DEFAULT_SETTINGS: RGSettings = {
  labelZoom: { connected: 0, mentioned: 10, candidate: 50 },
  graphLabels: true,
  animations: true,
  spread: 50
};

export default class RhizoneGraphPlugin extends Plugin implements ScopeHost, RhizoneHost {
  private index = new FacetIndex();
  private indexBuilt = false;
  private _contentCache: Map<string, string> | null = null; // path → lowercased body, for search
  private _settings: RGSettings = DEFAULT_SETTINGS;
  readonly previewOwner = this;

  /** Build the index lazily the first time anything needs it (cache is resolved by then). */
  private ensureIndex(): void {
    if (this.indexBuilt) return;
    this.index.addAll(buildRecords(this.app));
    this.indexBuilt = true;
  }

  /** Full rebuild from scratch — used once the metadata cache (re)resolves. */
  private rebuildIndex(): void {
    this.index = new FacetIndex();
    this.index.addAll(buildRecords(this.app));
    this.indexBuilt = true;
    this._contentCache = null; // bodies may have changed
    this.refreshView();
  }

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<RGSettings> | null;
    this._settings = {
      labelZoom: { ...DEFAULT_SETTINGS.labelZoom, ...(saved?.labelZoom ?? {}) },
      graphLabels: saved?.graphLabels ?? DEFAULT_SETTINGS.graphLabels,
      animations: saved?.animations ?? DEFAULT_SETTINGS.animations,
      spread: saved?.spread ?? DEFAULT_SETTINGS.spread
    };

    this.registerView(RETICULAR_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ReticularView(leaf, this));
    this.registerView(RHIZONE_FACET_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RhizoneFacetView(leaf, this));

    this.addCommand({
      id: "open-scope",
      name: "Open in Reticular Graph",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.openInScope(file.path);
        return true;
      }
    });
    this.addCommand({
      id: "open-rhizone",
      name: "Open Rhizone (Ten Gateways)",
      callback: () => void this.openRhizone()
    });

    this.addRibbonIcon("radar", "Open in Reticular Graph", () => {
      const file = this.app.workspace.getActiveFile();
      if (file && file.extension === "md") void this.openInScope(file.path);
    });
    this.addRibbonIcon("git-fork", "Open Rhizone", () => void this.openRhizone());

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Open in Reticular Graph")
            .setIcon("radar")
            .onClick(() => void this.openInScope(file.path))
        );
      })
    );
    // Editor right-click → open the local radar for this note.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, view) => {
        const file = view.file;
        if (!file || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Open in Reticular Graph")
            .setIcon("radar")
            .onClick(() => void this.openInScope(file.path))
        );
      })
    );

    // ── index lifecycle: build when the cache resolves, then incremental ───
    this.app.workspace.onLayoutReady(() => this.rebuildIndex());
    const rebuildSoon = debounce(() => this.rebuildIndex(), 800, true);
    this.registerEvent(this.app.metadataCache.on("resolved", rebuildSoon));

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.extension !== "md") return;
        this.index.update(recordFromCache(file.path, file.basename, this.app.metadataCache.getFileCache(file)));
        this._contentCache = null; // body changed → search cache stale
        this.refreshView();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.index.remove(oldPath);
        if (file instanceof TFile && file.extension === "md") {
          this.index.update(recordFromCache(file.path, file.basename, this.app.metadataCache.getFileCache(file)));
        }
        this.refreshView();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        this.index.remove(file.path);
        this.refreshView();
      })
    );

    // Follow the active note: when the active editor changes, re-aim any open (unpinned) scope.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const file = leaf?.view instanceof MarkdownView ? leaf.view.file : null;
        if (file && file.extension === "md") {
          for (const v of this.getScopeViews()) v.followActive(file.path);
        }
      })
    );
  }

  // ── ScopeHost ────────────────────────────────────────────────────────────
  getLocalWeb(focusPath: string): LocalWeb {
    this.ensureIndex();
    return buildLocalWeb(focusPath, this.index);
  }

  // ── RhizoneHost ──────────────────────────────────────────────────────────
  /** The whole vault as the Ten Gateways (Etz Chaim). */
  buildTree(): Tree {
    this.ensureIndex();
    return computeTree(this.index);
  }

  /** The whole-vault facet graph (perspectival rhizome). */
  facetGraph(): FacetGraph {
    this.ensureIndex();
    return buildFacetGraph(this.index);
  }

  /** Notes citing a facet — the doors that bloom from it. */
  notesForFacet(key: string): { path: string; basename: string }[] {
    this.ensureIndex();
    return [...this.index.notesWithFacet(key)]
      .map((p) => ({ path: p, basename: this.index.get(p)?.basename ?? p }))
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  /** Every note in the vault (the ever-present galaxy ring). */
  allNotes(): { path: string; basename: string }[] {
    this.ensureIndex();
    return [...this.index.all()].map((r) => ({ path: r.path, basename: r.basename }));
  }

  /** A note's facet keys (to seed the rhizome from a note keystone). */
  noteFacets(path: string): string[] {
    this.ensureIndex();
    return this.index.get(path)?.facetKeys ?? [];
  }

  /** Notes sharing any of `facetKeys`, ranked rarity-first (rarest shared facet wins). */
  relatedNotes(facetKeys: string[], exclude?: string): { path: string; basename: string; rarestDf: number }[] {
    this.ensureIndex();
    const rarest = new Map<string, number>(); // path → df of the rarest facet it shares
    for (const key of new Set(facetKeys)) {
      if (isContentTitle(key)) continue;
      const df = this.index.df(key);
      for (const p of this.index.notesWithFacet(key)) {
        if (p === exclude) continue;
        const cur = rarest.get(p);
        if (cur === undefined || df < cur) rarest.set(p, df);
      }
    }
    return [...rarest]
      .map(([path, rarestDf]) => ({ path, basename: this.index.get(path)?.basename ?? path, rarestDf }))
      .sort((a, b) => a.rarestDf - b.rarestDf || a.basename.localeCompare(b.basename));
  }

  /** Build (once) a lowercased body cache for content search. */
  private async ensureContentCache(): Promise<Map<string, string>> {
    if (this._contentCache) return this._contentCache;
    const cache = new Map<string, string>();
    await Promise.all(
      this.app.vault.getMarkdownFiles().map(async (f) => {
        try {
          cache.set(f.path, (await this.app.vault.cachedRead(f)).toLowerCase());
        } catch {
          /* unreadable — skip */
        }
      })
    );
    this._contentCache = cache;
    return cache;
  }

  /** Search filename + body; returns the best candidate doors, name-match weighted over body-match. */
  async searchNotes(query: string, limit = 3): Promise<{ path: string; basename: string }[]> {
    this.ensureIndex();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const content = await this.ensureContentCache();
    const scored: { path: string; basename: string; score: number }[] = [];
    for (const r of this.index.all()) {
      const name = r.basename.toLowerCase();
      let score = 0;
      if (name === q) score += 100;
      else if (name.startsWith(q)) score += 60;
      else if (name.includes(q)) score += 40;
      if ((content.get(r.path) ?? "").includes(q)) score += 12;
      if (score > 0) scored.push({ path: r.path, basename: r.basename, score });
    }
    scored.sort((a, b) => b.score - a.score || a.basename.localeCompare(b.basename));
    return scored.slice(0, limit).map(({ path, basename }) => ({ path, basename }));
  }

  /** A short plain-text peek at a note's body (frontmatter + markdown stripped). */
  async noteExcerpt(path: string, len = 200): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return "";
    try {
      const body = (await this.app.vault.cachedRead(f))
        .replace(/^---\n[\s\S]*?\n---\n?/, "") // frontmatter
        .replace(/!?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1") // wikilinks → text
        .replace(/[#>*_`~]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return body.length > len ? body.slice(0, len).trimEnd() + "…" : body;
    } catch {
      return "";
    }
  }

  /** Direct note→note links/connections across the whole vault (the ambient chord web). */
  noteLinks(): Array<[string, string]> {
    this.ensureIndex();
    return neighborEdges(
      [...this.index.all()].map((r) => r.path),
      this.index
    );
  }

  /** Each note's cluster = the facet-community most represented among its facets. */
  noteClusters(): Record<string, string> {
    this.ensureIndex();
    const labels = detectCommunities(buildFacetGraph(this.index));
    const out: Record<string, string> = {};
    for (const r of this.index.all()) {
      const tally = new Map<string, number>();
      for (const k of r.facetKeys) {
        if (isContentTitle(k)) continue;
        const lbl = labels.get(k);
        if (lbl) tally.set(lbl, (tally.get(lbl) ?? 0) + 1);
      }
      let best = "";
      let bestN = 0;
      for (const [lbl, n] of tally) if (n > bestN || (n === bestN && lbl < best)) ((best = lbl), (bestN = n));
      out[r.path] = best || "~"; // "~" sorts last → the unclustered drift to the end
    }
    return out;
  }

  neighborEdges(paths: string[]): Array<[string, string]> {
    this.ensureIndex();
    return neighborEdges(paths, this.index);
  }

  fileForPath(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  async readBody(path: string): Promise<string> {
    const f = this.fileForPath(path);
    return f ? this.app.vault.cachedRead(f) : "";
  }

  activePath(): string | null {
    const f = this.app.workspace.getActiveFile();
    return f && f.extension === "md" ? f.path : null;
  }

  labelThresholds(): { connected: number; mentioned: number; candidate: number } {
    return this._settings.labelZoom;
  }

  setLabelThreshold(state: NodeState, value: number): void {
    this._settings.labelZoom[state] = value;
    void this.saveData(this._settings);
  }

  graphLabels(): boolean {
    return this._settings.graphLabels;
  }

  setGraphLabels(on: boolean): void {
    this._settings.graphLabels = on;
    void this.saveData(this._settings);
  }

  phantomFacets(focusPath: string): PhantomFacet[] {
    this.ensureIndex();
    return phantomFacets(focusPath, this.index);
  }

  animations(): boolean {
    return this._settings.animations;
  }

  setAnimations(on: boolean): void {
    this._settings.animations = on;
    void this.saveData(this._settings);
  }

  spread(): number {
    return this._settings.spread;
  }
  setSpread(value: number): void {
    this._settings.spread = value;
    void this.saveData(this._settings);
  }

  debug(focusPath: string): { notes: number; focusFacets: number; focusFound: boolean } {
    this.ensureIndex();
    const rec = this.index.get(focusPath);
    return { notes: this.index.size(), focusFacets: rec?.facetKeys.length ?? 0, focusFound: !!rec };
  }

  async forge(focusPath: string, candidatePath: string): Promise<void> {
    const a = this.fileForPath(focusPath);
    const b = this.fileForPath(candidatePath);
    if (!a || !b) return;
    await forge(this.app, a, b);
    // Update the in-memory index immediately so the next render reflects the new
    // connection regardless of when the metadata cache catches up.
    this.bumpConnection(focusPath, b.basename);
    this.bumpConnection(candidatePath, a.basename);
  }

  /** Optimistically record a connection in the in-memory index record. */
  private bumpConnection(path: string, targetBasename: string): void {
    const rec = this.index.get(path);
    if (!rec) return;
    if (!rec.connections.includes(targetBasename)) {
      this.index.update({ ...rec, connections: [...rec.connections, targetBasename] });
    }
  }

  // ── view plumbing ──────────────────────────────────────────────────────────
  // NB: filter by instanceof — background tabs hold *deferred* placeholder views
  // (Obsidian ≥1.7) that lack our methods; skip them rather than crash on followActive/refresh.
  private getScopeViews(): ReticularView[] {
    return this.app.workspace
      .getLeavesOfType(RETICULAR_VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is ReticularView => v instanceof ReticularView);
  }

  private getRhizoneViews(): RhizoneFacetView[] {
    return this.app.workspace
      .getLeavesOfType(RHIZONE_FACET_VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is RhizoneFacetView => v instanceof RhizoneFacetView);
  }

  private refreshView(): void {
    for (const v of this.getScopeViews()) v.refresh();
    for (const v of this.getRhizoneViews()) v.refresh();
  }

  /** Open (or reveal) the Rhizone Ten-Gateways view in a main-area tab. */
  private async openRhizone(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(RHIZONE_FACET_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: RHIZONE_FACET_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async openInScope(path: string): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(RETICULAR_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: RETICULAR_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    (leaf.view as ReticularView).setFocus(path);
  }

  /** Point an already-open Reticular Scope at a note WITHOUT opening/revealing it (live highlight sync). */
  syncScope(path: string): void {
    for (const v of this.getScopeViews()) v.setFocus(path);
  }

}
