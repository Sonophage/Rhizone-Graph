// Facet normalization. PURE. Used for MATCHING ONLY — never written back to files
// (the vault's "Concept - " organizational prefix is preserved on disk).

const ATTACHMENT = /\.(jpe?g|png|gif|webp|svg|pdf|base)$/i;

// One leading "Capitalizedword - " organizational prefix (e.g. "Concept - ", "Movies - ").
// Requires a single all-letters token so "Year 34 - …" (digits/space) is left intact and
// does not collapse into a shorter facet.
const TYPE_PREFIX = /^[A-Z][A-Za-z]+ - /;

function bare(target: string): string {
  return target.split("|")[0].split("#")[0].trim();
}

export function isAttachment(target: string): boolean {
  return ATTACHMENT.test(bare(target));
}

/** Normalize a wikilink target to a facet match-key. Matching only — never written to disk. */
export function normalizeFacet(target: string): string {
  const t = bare(target).replace(TYPE_PREFIX, "");
  return t.normalize("NFC").toLowerCase();
}

/** Human-readable label for a raw target (prefix kept, alias/section dropped). */
export function facetLabel(target: string): string {
  return bare(target);
}
