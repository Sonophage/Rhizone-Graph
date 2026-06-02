import { Component, ItemView, MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import type { Candidate, NodeState } from "../engine/types.ts";
import type { ScopeHost } from "./ringView.ts";

export const RHIZONE_NOTE_VIEW_TYPE = "rhizone-graph-note";

const GLYPH: Record<NodeState, string> = { connected: "●", mentioned: "○", candidate: "✦" };
const SECTION_ORDER: NodeState[] = ["candidate", "connected", "mentioned"];
const SECTION_TITLE: Record<NodeState, string> = {
  candidate: "Candidates",
  connected: "Connected",
  mentioned: "Mentioned"
};

/**
 * Companion inspector. Reflects the galaxy's FOCUS note: breadcrumb, the focus card
 * (title + meta + excerpt + editable properties), then Candidate / Connected / Mentioned
 * sections of clickable connections. Click any row to traverse; designate to forge.
 */
export class RhizoneNoteView extends ItemView {
  private host: ScopeHost;
  private current = "";
  private trail: string[] = [];
  private child: Component | null = null;

  constructor(leaf: WorkspaceLeaf, host: ScopeHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return RHIZONE_NOTE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.current ? `Note · ${baseOf(this.current)}` : "Rhizone Note";
  }
  getIcon(): string {
    return "panel-right";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("rhizone-note");
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
    if (this.child) {
      this.removeChild(this.child);
      this.child = null;
    }

    const file = this.host.fileForPath(path);
    if (!file) {
      this.renderEmpty();
      return;
    }

    // ── breadcrumb track (moved here from the galaxy) ──────────────────────
    if (trail.length) {
      const track = el.createDiv({ cls: "rg-note-track" });
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

    const head = el.createDiv({ cls: "rg-note-head" });
    head.createSpan({ cls: "rg-note-title", text: file.basename });
    const open = head.createSpan({ cls: "rg-note-open", text: "open ↗", attr: { role: "button" } });
    open.onClickEvent(() => this.host.app.workspace.openLinkText(file.basename, path));

    const cache = this.host.app.metadataCache.getFileCache(file);
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "vault root";
    el.createDiv({ cls: "rg-note-meta", text: folder });
    const counts = el.createDiv({ cls: "rg-note-counts" }); // filled after sections exist

    // ── sections FIRST (above the Note), collapsed — open via header or count chip ─
    const byState: Record<NodeState, Candidate[]> = {
      candidate: web.outer,
      connected,
      mentioned
    };
    const sectionEls: Partial<Record<NodeState, HTMLDetailsElement>> = {};
    for (const state of SECTION_ORDER) {
      sectionEls[state] = this.renderSection(el, state, byState[state]);
    }

    // Unlinked mentions — wikilinks this note makes to targets that don't exist yet. Latent
    // connectors (other notes mentioning the same phantom). Toggleable via the gear.
    if (this.host.phantomEnabled()) {
      const phantoms = this.host.phantomFacets(path);
      if (phantoms.length) {
        const sec = el.createEl("details", { cls: "rg-note-section rg-phantom" });
        sec.open = true;
        const sum = sec.createEl("summary", { cls: "rg-note-section-title" });
        sum.createSpan({ cls: "rg-glyph", text: "◌" });
        sum.createSpan({ text: ` Ghost notes (${phantoms.length})` });
        for (const p of phantoms) {
          const row = sec.createDiv({ cls: "rg-note-row rg-phantom-row" });
          row.createSpan({ cls: "rg-note-row-name", text: "◌ " + p.label });
          row.createSpan({
            cls: "rg-note-why",
            text: p.shared > 1 ? `${p.shared} notes mention this` : "only here"
          });
        }
      }
    }

    // counts under the title — click a number to open that section
    for (const state of SECTION_ORDER) {
      const chip = counts.createSpan({ cls: `rg-count rg-${state}`, attr: { role: "button" } });
      chip.createSpan({ cls: `rg-glyph rg-${state}`, text: GLYPH[state] });
      chip.createSpan({ text: ` ${byState[state].length} ${SECTION_TITLE[state].toLowerCase()}` });
      chip.toggleClass("is-open", false);
      chip.onClickEvent(() => {
        const d = sectionEls[state];
        if (!d) return;
        d.open = !d.open; // the chip is the only control — toggle viewable
        chip.toggleClass("is-open", d.open);
        if (d.open) d.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }

    // ── properties (collapsed) then the Note (open) at the bottom ──────────
    this.renderProperties(el, file.path, (cache?.frontmatter ?? {}) as Record<string, unknown>);

    const noteBox = el.createEl("details", { cls: "rg-note-preview" });
    noteBox.open = true;
    noteBox.createEl("summary", { text: "Note" });
    const body = noteBox.createDiv({ cls: "rg-note-excerpt markdown-rendered" });
    const child = new Component();
    this.addChild(child);
    this.child = child;
    let md = "";
    try {
      md = await this.host.readBody(path);
    } catch {
      md = "";
    }
    await MarkdownRenderer.render(this.host.app, excerpt(neutralizeDynamic(md)), body, path, child);
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
        });
      }
    }
    return sec;
  }

  /** A simple typed, editable frontmatter form — writes back via processFrontMatter. */
  private renderProperties(el: HTMLElement, filePath: string, fm: Record<string, unknown>): void {
    const keys = Object.keys(fm);
    const details = el.createEl("details", { cls: "rg-note-props" });
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

function neutralizeDynamic(md: string): string {
  return md.replace(/```\s*(dataviewjs|dataview|templater-js|js-engine|ad-[\w-]+)[\s\S]*?```/gi, "> *[ dynamic block ]*");
}

function excerpt(md: string): string {
  const out = md.startsWith("---\n") ? md.slice(md.indexOf("\n---", 4) + 4) : md;
  return out
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 2600)
    .trim();
}
