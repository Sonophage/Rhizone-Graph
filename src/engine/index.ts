import type { NoteRecord } from "./types.ts";

/**
 * Inverted index over facets. PURE (no Obsidian imports).
 * `facetToNotes` gives co-citation lookups and `df` in O(1); incremental `update`
 * touches only the changed note's facets — never a full rescan.
 */
export class FacetIndex {
  private facetToNotes = new Map<string, Set<string>>(); // facetKey -> note paths
  private records = new Map<string, NoteRecord>();

  addAll(recs: NoteRecord[]): void {
    for (const r of recs) this.add(r);
  }

  add(r: NoteRecord): void {
    this.records.set(r.path, r);
    for (const key of new Set(r.facetKeys)) {
      let s = this.facetToNotes.get(key);
      if (!s) this.facetToNotes.set(key, (s = new Set()));
      s.add(r.path);
    }
  }

  /** Remove a note's contribution, then re-add from the new record. O(facets of that note). */
  update(r: NoteRecord): void {
    this.remove(r.path);
    this.add(r);
  }

  remove(path: string): void {
    const old = this.records.get(path);
    if (!old) return;
    for (const key of new Set(old.facetKeys)) {
      const s = this.facetToNotes.get(key);
      if (s) {
        s.delete(path);
        if (s.size === 0) this.facetToNotes.delete(key);
      }
    }
    this.records.delete(path);
  }

  df(facetKey: string): number {
    return this.facetToNotes.get(facetKey)?.size ?? 0;
  }

  notesWithFacet(facetKey: string): Set<string> {
    return this.facetToNotes.get(facetKey) ?? new Set();
  }

  get(path: string): NoteRecord | undefined {
    return this.records.get(path);
  }

  all(): IterableIterator<NoteRecord> {
    return this.records.values();
  }

  size(): number {
    return this.records.size;
  }
}
