import type { App, TFile } from "obsidian";

/**
 * The connections data layer. Pure merge/remove/dangling helpers (unit-tested) plus thin
 * Obsidian wrappers that write ONLY through app.fileManager.processFrontMatter — never manual
 * YAML (amendment #2). Forge is bidirectional, sequenced, and idempotent (re-run heals).
 */

function base(token: string): string {
  return token
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    .split("#")[0]
    .split("/")
    .pop()!
    .replace(/\.md$/i, "")
    .trim();
}

/** Pure: next connections array after adding a target. Idempotent, deduped, self-guarded. */
export function mergeConnection(current: string[], targetBasename: string, focusBasename?: string): string[] {
  const t = base(targetBasename);
  if (!t || t === focusBasename) return current;
  if (current.some((c) => base(c) === t)) return current; // already present -> heal/no-op
  return [...current, `[[${t}]]`];
}

/** Pure: next connections array after removing a target (matched by basename). */
export function removeConnection(current: string[], targetBasename: string): string[] {
  const t = base(targetBasename);
  return current.filter((c) => base(c) !== t);
}

/** Pure: does this connection entry point at a note that no longer exists? */
export function isDangling(entry: string, existingBasenames: Set<string>): boolean {
  return !existingBasenames.has(base(entry));
}

function readConnections(fm: Record<string, unknown>): string[] {
  const raw = fm.connections;
  return Array.isArray(raw) ? (raw as string[]) : raw == null ? [] : [String(raw)];
}

/** Bidirectional forge. Sequenced; re-running heals a half-written pair, never duplicates. */
export async function forge(app: App, a: TFile, b: TFile): Promise<void> {
  await writeOne(app, a, b.basename);
  await writeOne(app, b, a.basename);
}

async function writeOne(app: App, file: TFile, targetBasename: string): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm.connections = mergeConnection(readConnections(fm), targetBasename, file.basename);
  });
}

/** Remove a connection from one side. Caller mirrors on the other side when appropriate. */
export async function unforge(app: App, file: TFile, targetBasename: string): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm.connections = removeConnection(readConnections(fm), targetBasename);
  });
}

/** Rewrite a connection entry to a new target (Repoint/Reconnect remediation). */
export async function repoint(app: App, file: TFile, oldTarget: string, newTarget: string): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    const without = removeConnection(readConnections(fm), oldTarget);
    fm.connections = mergeConnection(without, newTarget, file.basename);
  });
}
