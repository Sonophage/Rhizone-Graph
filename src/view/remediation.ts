import type { TFile } from "obsidian";
import { mergeConnection, removeConnection } from "../obsidian/connections.ts";
import type { ScopeHost } from "./ringView.ts";

export type RemediationAction = "reconnect" | "repoint" | "delete";

/** Pure: the actions offered for a connection entry. Dangling entries get all three. */
export function remediationActions(isDangling: boolean): RemediationAction[] {
  return isDangling ? ["reconnect", "repoint", "delete"] : [];
}

/** Pure: the next connections array after a remediation. reconnect/repoint require a newTarget. */
export function planRemediation(
  current: string[],
  action: RemediationAction,
  oldTarget: string,
  newTarget?: string
): string[] {
  if (action === "delete") return removeConnection(current, oldTarget);
  if (!newTarget) return current; // reconnect/repoint need a chosen note
  return mergeConnection(removeConnection(current, oldTarget), newTarget);
}

/** Apply a remediation to the focus note (and mirror onto the new target where applicable). */
export async function applyRemediation(
  host: ScopeHost,
  focusPath: string,
  action: RemediationAction,
  oldTarget: string,
  newTarget?: TFile
): Promise<void> {
  const focus = host.fileForPath(focusPath);
  if (!focus) return;
  await host.app.fileManager.processFrontMatter(focus, (fm) => {
    const cur: string[] = Array.isArray(fm.connections)
      ? fm.connections
      : fm.connections == null
        ? []
        : [String(fm.connections)];
    fm.connections = planRemediation(cur, action, oldTarget, newTarget?.basename);
  });
  // reconnect/repoint: write the reverse side onto the chosen note too.
  if (newTarget && action !== "delete") {
    await host.app.fileManager.processFrontMatter(newTarget, (fm) => {
      const cur: string[] = Array.isArray(fm.connections)
        ? fm.connections
        : fm.connections == null
          ? []
          : [String(fm.connections)];
      fm.connections = mergeConnection(cur, focus.basename, newTarget.basename);
    });
  }
}
