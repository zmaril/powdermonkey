import type { IDecoration, IDisposable, Terminal } from "@xterm/xterm";
import { findPmIds } from "./pm-ids.ts";

// Persistent link *styling* for PM ids in the terminal — blue + underlined at all times,
// not just on hover. The link provider (pm-id-links.ts) owns the interaction (click +
// hover pointer); this owns the look. xterm has no "always styled" mode for provider
// links, so for each id we place a decoration over its cells: `foregroundColor` tints the
// glyphs to the accent, and the decoration element gets an underline.
//
// We re-scan on every render (`onRender`, coalesced to a frame) and diff against what's
// placed, so the styling stays correct even when a full-screen TUI (Claude Code) repaints
// a line — a line whose text changed drops its stale decoration and gets a fresh one. In
// steady state the diff is empty, so it settles without churning renders.

export class PmIdDecorator {
  private placed = new Map<string, IDecoration>();
  private sub: IDisposable;
  private scheduled = false;
  private disposed = false;

  constructor(
    private readonly term: Terminal,
    private color: string,
  ) {
    this.sub = term.onRender(() => this.schedule());
    this.schedule();
  }

  /** Re-tint to a new accent (theme change). */
  setColor(color: string): void {
    if (color === this.color) return;
    this.color = color;
    this.clear(); // colour is baked into each decoration; rebuild them
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.sub.dispose();
    this.clear();
  }

  private clear(): void {
    for (const d of this.placed.values()) d.dispose();
    this.placed.clear();
  }

  // Coalesce the render-driven rescans to one per frame, and run outside xterm's render
  // call stack (registering decorations mid-render is asking for trouble).
  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      if (!this.disposed) this.sync();
    });
  }

  private sync(): void {
    const buf = this.term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;

    // Desired decorations across the active screen (the rows the cursor's buffer covers).
    // Ids that scrolled up into the scrollback keep the decoration already anchored to
    // their line — markers scroll-track on their own — so we only (re)scan the live rows.
    const desired = new Map<string, { offset: number; x: number; width: number }>();
    for (let r = 0; r < this.term.rows; r++) {
      const abs = buf.baseY + r;
      const line = buf.getLine(abs);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text) continue;
      for (const m of findPmIds(text)) {
        // Ids are ASCII, so the string index equals the cell column here.
        desired.set(`${abs}:${m.index}:${m.text}`, {
          offset: abs - cursorAbs,
          x: m.index,
          width: m.length,
        });
      }
    }

    // Drop decorations whose line/text no longer matches (scrolled off, or repainted).
    for (const [key, deco] of this.placed) {
      if (!desired.has(key)) {
        deco.dispose();
        this.placed.delete(key);
      }
    }
    // Place the new ones.
    for (const [key, d] of desired) {
      if (this.placed.has(key)) continue;
      const marker = this.term.registerMarker(d.offset);
      if (!marker) continue;
      const deco = this.term.registerDecoration({
        marker,
        x: d.x,
        width: d.width,
        height: 1,
        foregroundColor: this.color,
        layer: "top",
      });
      if (!deco) {
        marker.dispose();
        continue;
      }
      deco.onRender((el) => {
        // The glyph is already tinted via foregroundColor; add the underline (a bottom
        // border on the overlay). pointer-events:none so this styling overlay never
        // intercepts the click — that belongs to the link provider (pm-id-links.ts),
        // which drives the reveal + the hover pointer.
        el.style.borderBottom = `1px solid ${this.color}`;
        el.style.boxSizing = "border-box";
        el.style.pointerEvents = "none";
      });
      this.placed.set(key, deco);
    }
  }
}
