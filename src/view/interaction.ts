// Interaction helpers. `BreadcrumbTrail` is PURE (unit-tested). The keyboard installer is
// DOM-only (no Obsidian import) so it stays testable-by-smoke and theme-agnostic.

/** Records the traversal walk. No consecutive duplicates; jumpTo truncates forward history. */
export class BreadcrumbTrail {
  private trail: string[];

  constructor(root: string) {
    this.trail = [root];
  }

  push(path: string): void {
    if (this.trail[this.trail.length - 1] === path) return; // no consecutive dupe
    this.trail.push(path);
  }

  /** Truncate the trail so `index` becomes the last (current) crumb. */
  jumpTo(index: number): void {
    if (index < 0 || index >= this.trail.length) return;
    this.trail = this.trail.slice(0, index + 1);
  }

  /** Pop one crumb; returns the new current. No-op at the root. */
  back(): string {
    if (this.trail.length > 1) this.trail.pop();
    return this.current();
  }

  current(): string {
    return this.trail[this.trail.length - 1];
  }

  items(): string[] {
    return [...this.trail];
  }
}

export interface KeyHandlers {
  traverse: () => void; // Enter
  forge: () => void; // F
  back: () => void; // Esc / Backspace
}

/**
 * Roving-tabindex keyboard nav over focusable contact elements within `root`.
 * Tab/Shift+Tab cycle contacts; Enter traverses; F forges; Esc goes back.
 */
export function installKeyboardNav(root: HTMLElement | SVGElement, handlers: KeyHandlers): void {
  const focusables = () => Array.from(root.querySelectorAll<SVGElement>("[data-rg-contact]"));
  root.addEventListener("keydown", (ev: KeyboardEvent) => {
    const items = focusables();
    if (items.length === 0) return;
    const active = document.activeElement as Element | null;
    const i = items.findIndex((el) => el === active);
    switch (ev.key) {
      case "Tab": {
        ev.preventDefault();
        const next = ev.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
        items[next].focus();
        break;
      }
      case "Enter":
        ev.preventDefault();
        handlers.traverse();
        break;
      case "f":
      case "F":
        ev.preventDefault();
        handlers.forge();
        break;
      case "Escape":
      case "Backspace":
        ev.preventDefault();
        handlers.back();
        break;
    }
  });
}
