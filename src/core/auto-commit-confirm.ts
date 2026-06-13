/**
 * Auto-commit confirmation dialog component.
 *
 * Renders a full-screen overlay (clears previous content, shows only dialog)
 * when auto-commit changes need user confirmation.
 */

import { matchesKey, Key, type Component, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { t } from "../utils/lang.js";

/** Maximum files to display in the dialog before showing "...and N more" */
const MAX_DISPLAY_FILES = 8;

/** Timeout in ms before auto-dismissing as "No" */
const CONFIRM_TIMEOUT_MS = 120_000;

/** Maximum lines rendered for the full-screen overlay (safety cap for extreme terminals) */
const MAX_RENDERED_LINES = 200;

/** Factory returned by createConfirmComponent, compatible with ctx.ui.custom<T>() */
export type ConfirmComponentFactory = (
  tui: { requestRender: () => void; terminal?: { rows: number } },
  theme: Theme,
  _keybindings: unknown,
  done: (result: boolean) => void,
) => Component & { dispose?(): void };

export interface ConfirmDialogParams {
  /** All changed files (tracked + untracked) */
  changedFiles: string[];
  /** Files that are untracked (for "(new)" marker) */
  untrackedFiles: string[];
  /** Total lines changed (tracked + untracked) */
  totalLines: number;
  /** Whether any changed file is binary */
  hasBinary: boolean;
  /** Display language */
  lang: string;
}

/**
 * Create a confirmation dialog component factory for use with ctx.ui.custom().
 */
export function createConfirmComponent(
  params: ConfirmDialogParams,
): ConfirmComponentFactory {
  return (tui, theme, _keybindings, done) =>
    new ConfirmOverlay(tui, theme, params, done);
}

// ───────────────────────────────────────────────
// ConfirmOverlay — the full-screen Yes/No overlay
// ───────────────────────────────────────────────

class ConfirmOverlay implements Component {
  private disposed = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private termHeight: number;

  constructor(
    private tui: { requestRender: () => void; terminal?: { rows: number } },
    private theme: Theme,
    private params: ConfirmDialogParams,
    private done: (result: boolean) => void,
  ) {
    this.termHeight = Math.min(
      tui.terminal?.rows ?? 24,
      MAX_RENDERED_LINES,
    );

    // Guard: empty file list — immediately resolve as if declined
    if (params.changedFiles.length === 0) {
      this.disposed = true;
      this.done(false);
      return;
    }

    this.timeoutId = setTimeout(() => {
      if (!this.disposed) {
        this.disposed = true;
        this.done(false);
      }
    }, CONFIRM_TIMEOUT_MS);
  }

  // ── Component interface ──────────────────────────────

  invalidate(): void {
    /* stateless render — no cache to invalidate */
  }

  handleInput(data: string): void {
    if (this.disposed) return;

    // Enter (submit)
    if (matchesKey(data, Key.enter)) {
      this.resolve(true);
      return;
    }

    // Escape
    if (matchesKey(data, Key.escape)) {
      this.resolve(false);
      return;
    }

    // Ctrl+C — treat as "No"
    if (matchesKey(data, Key.ctrl("c"))) {
      this.resolve(false);
      return;
    }

    // Printable keys: y / Y → yes, n / N → no
    if (data.length === 1) {
      const ch = data.toLowerCase();
      if (ch === "y") {
        this.resolve(true);
        return;
      }
      if (ch === "n") {
        this.resolve(false);
        return;
      }
    }
  }

  render(width: number): string[] {
    const { changedFiles, untrackedFiles, totalLines, hasBinary, lang } =
      this.params;

    // ── Build content lines (unstyled — styling applied during padding) ──
    const content: string[] = [];

    // Title bar
    const title = t(lang, "autoCommit.confirmTitle");
    const titleBar = `── ${title} ──`;
    content.push(this.theme.fg("accent", titleBar));

    content.push("");

    // Body: file count + line count
    const filesText = String(changedFiles.length);
    let linesText: string;
    if (hasBinary && totalLines === 0) {
      linesText = t(lang, "autoCommit.confirmBodyBinary");
    } else {
      linesText = t(lang, "autoCommit.confirmBodyLines", {
        count: String(totalLines),
      });
    }
    content.push(
      t(lang, "autoCommit.confirmBody", {
        files: filesText,
        lines: linesText,
      }),
    );

    content.push("");

    // Files list
    if (changedFiles.length > 0) {
      content.push("Files:");
      const displayCount = Math.min(changedFiles.length, MAX_DISPLAY_FILES);
      for (let i = 0; i < displayCount; i++) {
        const file = changedFiles[i]!;
        const isNew = untrackedFiles.includes(file);
        const newLabel = isNew ? ` ${t(lang, "autoCommit.confirmNewFile")}` : "";
        const display = truncateToWidth(
          `  ${file}${newLabel}`,
          width - 4,
          "\u2026",
        );
        content.push(this.theme.fg("muted", display));
      }
      if (changedFiles.length > MAX_DISPLAY_FILES) {
        const moreText = t(lang, "autoCommit.confirmMoreFiles", {
          count: String(changedFiles.length - MAX_DISPLAY_FILES),
        });
        content.push(this.theme.fg("dim", `  ${moreText}`));
      }
    }

    content.push("");

    // Key hints
    const yesText = t(lang, "autoCommit.confirmYes");
    const noText = t(lang, "autoCommit.confirmNo");
    content.push(
      `  ${this.theme.fg("success", `[ ${yesText} ]`)}    ${this.theme.fg("warning", `[ ${noText} ]`)}`,
    );

    // ── Frame: center content vertically, pad each line to full width ──
    const lines: string[] = [];
    const contentHeight = content.length;

    // Top padding: vertical centering
    // On very small terminals, pad=0 so content starts immediately
    const topPad = Math.max(
      0,
      Math.floor((this.termHeight - contentHeight) / 2),
    );

    // Background fill helper
    const fillBg = (text: string): string =>
      this.theme.bg("selectedBg", text);

    for (let i = 0; i < topPad; i++) {
      lines.push(fillBg(" ".repeat(width)));
    }

    // Content lines: center horizontally, pad to full width
    for (const line of content) {
      const visW = visibleWidth(line);
      const leftPad = Math.max(0, Math.floor((width - visW) / 2));
      const padded = " ".repeat(leftPad) + line;
      lines.push(fillBg(padded.padEnd(width, " ")));
    }

    // Bottom padding: fill remaining terminal height
    while (lines.length < this.termHeight) {
      lines.push(fillBg(" ".repeat(width)));
    }

    return lines;
  }

  dispose(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (!this.disposed) {
      this.disposed = true;
      this.done(false);
    }
  }

  // ── Private helpers ────────────────────────────────

  private resolve(result: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.done(result);
  }
}
