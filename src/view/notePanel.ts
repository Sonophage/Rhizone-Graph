import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { Candidate, NodeState } from "../engine/types.ts";
import type { PhantomFacet } from "../engine/cocitation.ts";
import type { ScopeHost } from "./ringView.ts";

export const RETICULAR_NOTE_VIEW_TYPE = "reticular-note";

const GLYPH: Record<NodeState, string> = { connected: "●", mentioned: "○", candidate: "✦" };
const SECTION_ORDER: NodeState[] = ["candidate", "connected", "mentioned"];
const SECTION_TITLE: Record<NodeState, string> = {
  candidate: "Candidates",
  connected: "Connected",
  mentioned: "Mentioned"
};

/**
 * Companion inspector. Reflects the galaxy's FOCUS note: breadcrumb, the focus card
 * (title + meta + connection counts + editable properties), then Candidate / Connected /
 * Mentioned / Ghost sections of clickable connections. Click any row to traverse; designate
 * to forge. Hovering a row (or the title) shows a native page-preview popover on the mouse and
 * spotlights its node in the graph.
 */
export class ReticularNoteView extends ItemView {
  private host: ScopeHost;
  private current = "";
  private trail: string[] = [];

  constructor(leaf: WorkspaceLeaf, host: ScopeHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return RETICULAR_NOTE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.current ? `Note · ${baseOf(this.current)}` : "Reticular Note";
  }
  getIcon(): string {
    return "panel-right";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("reticular-note");
    this.renderEmpty();
  }

  private renderEmpty(): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "rg-note-empty", text: "Focus a note in the galaxy to inspect it here." });
  }

  /** Render the inspector for `path`, with the current breadcrumb `trail`. */
  async update(path: string, trail: string[]): Promise<void> {
    this.current = path;
    this.trail = trail;
    const el = this.contentEl;
    el.empty();

    const file = this.host.fileForPath(path);
    if (!file) {
      this.renderEmpty();
      return;
    }

    // single scroll container — theme-proof (don't rely on .view-content scrolling)
    const root = el.createDiv({ cls: "rg-note-scroll" });

    // ── breadcrumb track (moved here from the galaxy) ──────────────────────
    if (trail.length) {
      const track = root.createDiv({ cls: "rg-note-track" });
      track.createSpan({ cls: "rg-note-track-label", text: "track:" });
      trail.forEach((p, i) => {
        const crumb = track.createSpan({ cls: "rg-note-crumb", text: baseOf(p) });
        crumb.onClickEvent(() => this.host.jumpScope(p));
        if (i < trail.length - 1) track.createSpan({ cls: "rg-note-crumb-sep", text: " › " });
      });
    }

    // ── focus card ─────────────────────────────────────────────────────────
    const web = this.host.getLocalWeb(path);
    const connected = web.inner.filter((c) => c.state === "connected");
    const mentioned = web.inner.filter((c) => c.state === "mentioned");

    const head = root.createDiv({ cls: "rg-note-head" });
    const title = head.createSpan({ cls: "rg-note-title", text: file.basename });
    title.addEventListener("mouseover", (ev) => this.hoverLink(ev, title, file.basename));
    const open = head.createSpan({ cls: "rg-note-open", text: "open ↗", attr: { role: "button" } });
    open.onClickEvent(() => this.host.app.workspace.openLinkText(file.basename, path));

    const cache = this.host.app.metadataCache.getFileCache(file);
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "vault root";
    root.createDiv({ cls: "rg-note-meta", text: folder });
    const counts = root.createDiv({ cls: "rg-note-counts" }); // filled after sections exist

    // ── sections FIRST (above the Note), collapsed — revealed by their count chip ─
    const byState: Record<NodeState, Candidate[]> = { candidate: web.outer, connected, mentioned };
    const sections: Array<{ key: string; glyph: string; label: string; count: number; el: HTMLDetailsElement }> = [];
    for (const state of SECTION_ORDER) {
      sections.push({
        key: state,
        glyph: GLYPH[state],
        label: SECTION_TITLE[state].toLowerCase(),
        count: byState[state].length,
        el: this.renderSection(root, state, byState[state])
      });
    }

    // Ghost notes — wikilinks this note makes to targets that don't exist yet (latent connectors).
    // Same affordance as the other sections now: its own count chip, collapsed by default, always present.
    const phantoms = this.host.phantomFacets(path);
    sections.push({ key: "ghost", glyph: "◌", label: "ghost notes", count: phantoms.length, el: this.renderGhostSection(root, phantoms) });

    // counts under the title — the only show/hide control for each section
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

    // ── properties (open by default) ──
    this.renderProperties(root, file.path, (cache?.frontmatter ?? {}) as Record<string, unknown>);
  }

  /** Fire Obsidian's native page-preview popover near `el` for `basename` (needs core Page Preview). */
  private hoverLink(ev: MouseEvent, el: HTMLElement, basename: string): void {
    this.host.app.workspace.trigger("hover-link", {
      event: ev,
      source: "reticular-graph",
      hoverParent: this,
      targetEl: el,
      linktext: basename,
      sourcePath: this.current
    });
  }

  /** Ghost-notes section — phantom wikilinks + how many notes share each. Collapsed; its chip reveals it. */
  private renderGhostSection(el: HTMLElement, phantoms: PhantomFacet[]): HTMLDetailsElement {
    const sec = el.createEl("details", { cls: "rg-note-section rg-ghost" });
    sec.open = false;
    const title = sec.createEl("summary", { cls: "rg-note-section-title" });
    title.createSpan({ cls: "rg-glyph rg-ghost", text: "◌" });
    title.createSpan({ text: ` Ghost notes (${phantoms.length})` });
    if (!phantoms.length) {
      sec.createDiv({ cls: "rg-note-section-empty", text: "—" });
      return sec;
    }
    for (const p of phantoms) {
      const row = sec.createDiv({ cls: "rg-note-row rg-phantom-row" });
      row.createSpan({ cls: "rg-note-row-name", text: "◌ " + p.label });
      row.createSpan({ cls: "rg-note-why", text: p.shared > 1 ? `${p.shared} notes mention this` : "only here" });
    }
    return sec;
  }

  private renderSection(el: HTMLElement, state: NodeState, items: Candidate[]): HTMLDetailsElement {
    const sec = el.createEl("details", { cls: `rg-note-section rg-${state}` });
    sec.open = false; // collapsed by default; open via its title or the count chip
    const title = sec.createEl("summary", { cls: "rg-note-section-title" });
    title.createSpan({ cls: `rg-glyph rg-${state}`, text: GLYPH[state] });
    title.createSpan({ text: ` ${SECTION_TITLE[state]} (${items.length})` });
    if (items.length === 0) {
      sec.createDiv({ cls: "rg-note-section-empty", text: "—" });
      return sec;
    }
    for (const c of items) {
      const row = sec.createDiv({ cls: "rg-note-row" + (c.dangling ? " rg-dangling" : "") });
      const name = row.createSpan({ cls: "rg-note-row-name", text: (c.dangling ? "⚠ " : "") + c.basename });
      name.onClickEvent(() => {
        if (!c.dangling) this.host.focusScope(c.path);
      });
      // hover a row → spotlight its node in the Scope graph + a native page-preview popover on the mouse
      if (!c.dangling && c.path) {
        row.addEventListener("mouseenter", () => this.host.spotlightScope(c.path, true));
        row.addEventListener("mouseleave", () => this.host.spotlightScope(c.path, false));
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
          await this.host.forge(this.current, c.path);
          this.host.refreshScope();
          void this.update(this.current, this.trail); // re-render the companion so the candidate moves to Connected
        });
      }
    }
    return sec;
  }

  /** A simple typed, editable frontmatter form — writes back via processFrontMatter. */
  private renderProperties(el: HTMLElement, filePath: string, fm: Record<string, unknown>): void {
    const keys = Object.keys(fm);
    const details = el.createEl("details", { cls: "rg-note-props" });
    details.open = true; // properties open by default
    details.createEl("summary", { text: `Properties (${keys.length})` });
    if (keys.length === 0) {
      details.createDiv({ cls: "rg-note-section-empty", text: "no properties" });
      return;
    }
    for (const key of keys) {
      const value = fm[key];
      const row = details.createDiv({ cls: "rg-prop-row" });
      row.createSpan({ cls: "rg-prop-key", text: key });
      const save = (next: unknown): void => void this.writeProp(filePath, key, next);

      if (typeof value === "boolean") {
        const box = row.createEl("input", { cls: "rg-prop-bool", attr: { type: "checkbox" } });
        box.checked = value;
        box.addEventListener("change", () => save(box.checked));
      } else if (typeof value === "number") {
        const inp = row.createEl("input", { cls: "rg-prop-input", attr: { type: "number", value: String(value) } });
        inp.addEventListener("change", () => save(inp.value === "" ? null : Number(inp.value)));
      } else if (Array.isArray(value)) {
        const area = row.createEl("textarea", { cls: "rg-prop-area" });
        area.value = value.map(String).join("\n");
        area.addEventListener("change", () => {
          const lines = area.value.split("\n").map((s) => s.trim()).filter(Boolean);
          save(lines);
        });
      } else {
        const inp = row.createEl("input", { cls: "rg-prop-input", attr: { type: "text", value: value == null ? "" : String(value) } });
        inp.addEventListener("change", () => save(inp.value));
      }
    }
  }

  private async writeProp(filePath: string, key: string, next: unknown): Promise<void> {
    const file = this.host.fileForPath(filePath);
    if (!file) return;
    await this.host.app.fileManager.processFrontMatter(file, (data) => {
      data[key] = next;
    });
  }
}

function baseOf(p: string): string {
  return p.split("/").pop()!.replace(/\.md$/i, "");
}
