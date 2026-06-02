import { MarkdownRenderer } from "obsidian";
import type { ScopeHost } from "./ringView.ts";

const PREVIEW_CLASS = "rg-preview";
const MAX_CHARS = 1200; // a glance, not the whole note

/**
 * Render an inline markdown preview of `path` into a `.rg-preview` child of `parent`.
 * Uses MarkdownRenderer (never innerHTML). An empty path clears the region.
 */
export async function renderPreview(host: ScopeHost, path: string, parent: HTMLElement): Promise<void> {
  let region = parent.querySelector<HTMLElement>(`.${PREVIEW_CLASS}`);
  if (!region) region = parent.createDiv({ cls: PREVIEW_CLASS });
  region.empty();
  if (!path) return;

  const file = host.fileForPath(path);
  if (!file) return;
  let body = "";
  try {
    body = await host.readBody(path);
  } catch {
    return;
  }
  const excerpt = cleanExcerpt(body).slice(0, MAX_CHARS).trim();
  await MarkdownRenderer.render(host.app, excerpt, region, path, host.previewOwner);
}

/** Drop frontmatter and image/banner embeds so the preview reads as text, not chrome. */
function cleanExcerpt(md: string): string {
  let out = md;
  if (out.startsWith("---\n")) {
    const end = out.indexOf("\n---", 4);
    if (end !== -1) out = out.slice(end + 4);
  }
  out = out
    .replace(/```[\s\S]*?```/g, "") // fenced code (dataviewjs/score blocks etc — never execute them)
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/!\[\[[^\]]*\]\]/g, "") // ![[embedded image / banner]]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // ![alt](src)
    .replace(/%%[\s\S]*?%%/g, ""); // obsidian comments
  return out.replace(/\n{3,}/g, "\n\n");
}
