import type { App, CachedMetadata } from "obsidian";
import type { NoteRecord } from "../engine/types.ts";
import { facetLabel, isAttachment, normalizeFacet } from "../engine/alias.ts";

/**
 * Build a NoteRecord from Obsidian's metadata cache. PURE over its inputs (the `obsidian`
 * import is type-only, so this is unit-testable with plain mock cache objects).
 * Links are taken from the cache — never regex-parsed from note bodies (amendment #3).
 */
// Frontmatter fields that are NOT facets: `connections` is the curated layer (handled
// separately), `categories` is organizational note-type classification (pure noise as a facet).
const EXCLUDED_FM_KEY = /^(connections|categories)(\.|$)/;

export function recordFromCache(path: string, basename: string, cache: CachedMetadata | null): NoteRecord {
  const facetKeys: string[] = [];
  const facetLabels: Record<string, string> = {};
  const linkPaths: string[] = [];

  const add = (link: string): void => {
    if (isAttachment(link)) return;
    const key = normalizeFacet(link);
    if (!key) return;
    facetKeys.push(key);
    if (!facetLabels[key]) facetLabels[key] = facetLabel(link);
    linkPaths.push(baseName(link));
  };

  for (const l of cache?.links ?? []) add(l.link); // body links
  for (const l of cache?.frontmatterLinks ?? []) {
    if (EXCLUDED_FM_KEY.test(l.key ?? "")) continue; // skip connections + categories
    add(l.link);
  }

  const connections = toBasenames(cache?.frontmatter?.connections);
  return { path, basename, facetKeys, facetLabels, linkPaths, connections };
}

/** Walk the vault and build every note's record. The only non-pure entry point. */
export function buildRecords(app: App): NoteRecord[] {
  return app.vault
    .getMarkdownFiles()
    .map((f) => recordFromCache(f.path, f.basename, app.metadataCache.getFileCache(f)));
}

/** Normalize a `connections` frontmatter value (array | string | null | "[[wikilink]]") to basenames. */
function toBasenames(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return arr.map((v) => baseName(String(v))).filter(Boolean);
}

function baseName(token: string): string {
  return token
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    .split("#")[0]
    .split("/")
    .pop()!
    .replace(/\.md$/i, "")
    .trim();
}
