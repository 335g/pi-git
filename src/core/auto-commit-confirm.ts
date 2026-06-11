/**
 * Auto-commit confirmation dialog component.
 *
 * Shows an overlay Yes/No dialog when auto-commit changes are small,
 * giving the user a chance to review before committing.
 */

import { matchesKey, Key, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { t } from "../utils/lang.js";

/** Maximum files to display in the dialog before showing "...and N more" */
const MAX_DISPLAY_FILES = 8;

/** Timeout in ms before auto-dismissing as "No" */
const CONFIRM_TIMEOUT_MS = 120_000;

/** Factory returned by createConfirmComponent, compatible with ctx.ui.custom<T>() */
export type ConfirmComponentFactory = (
  tui: { requestRender: () => void },
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
// ConfirmOverlay — the Yes/No overlay component
// ───────────────────────────────────────────────

class ConfirmOverlay implements Component {
  private disposed = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private tui: { requestRender: () => void },
    private theme: Theme,
    private params: ConfirmDialogParams,
    private done: (result: boolean) => void,
  ) {
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
    const lines: string[] = [];

    // Title bar
    const title = t(lang, "autoCommit.confirmTitle");
    const titleBar = `── ${title} `.padEnd(width, "─");
    lines.push(this.theme.fg("accent", titleBar));

    lines.push("");

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
    const bodyLine = t(lang, "autoCommit.confirmBody", {
      files: filesText,
      lines: linesText,
    });
    lines.push(bodyLine);

    lines.push("");

    // Files list
    if (changedFiles.length > 0) {
      lines.push("Files:");
      const displayCount = Math.min(changedFiles.length, MAX_DISPLAY_FILES);
      for (let i = 0; i < displayCount; i++) {
        const file = changedFiles[i]!;
        const isNew = untrackedFiles.includes(file);
        const newLabel = isNew ? ` ${t(lang, "autoCommit.confirmNewFile")}` : "";
        // Truncate to width minus indent (2 spaces)
        const maxLen = width - 2;
        let display = `  ${file}${newLabel}`;
        if (display.length > maxLen) {
          display = display.substring(0, maxLen);
        }
        lines.push(this.theme.fg("muted", display));
      }
      if (changedFiles.length > MAX_DISPLAY_FILES) {
        const moreText = t(lang, "autoCommit.confirmMoreFiles", {
          count: String(changedFiles.length - MAX_DISPLAY_FILES),
        });
        lines.push(this.theme.fg("dim", `  ${moreText}`));
      }
    }

    lines.push("");

    // Key hints
    const yesText = t(lang, "autoCommit.confirmYes");
    const noText = t(lang, "autoCommit.confirmNo");
    lines.push(
      `  ${this.theme.fg("success", `[ ${yesText} ]`)}    ${this.theme.fg("warning", `[ ${noText} ]`)}`,
    );

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
