import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseNameStatus } from "./commit-message.js";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * An item representing a staged file with its selection state.
 */
export interface FileItem {
	status: string;
	path: string;
	selected: boolean;
}

/**
 * Status-label map for human-friendly display.
 */
const STATUS_LABELS: Record<string, string> = {
	A: "new",
	M: "mod",
	D: "del",
	R: "ren",
	C: "cpy",
};

/**
 * Foreground colour key per status (used with theme.fg).
 */
const STATUS_COLORS: Record<string, "success" | "warning" | "error" | "accent" | "dim" | "muted"> = {
	A: "success",
	M: "warning",
	D: "error",
	R: "accent",
	C: "accent",
};

/**
 * Show an interactive file selector for staged files.
 *
 * **TUI mode** – presents an interactive multi‑select list where the user
 * can toggle individual files (Space) or all files (A), then confirm (Enter)
 * or cancel (Esc / Ctrl+C).
 *
 * **Non‑TUI mode** – prints the file list via `ctx.ui.notify` and returns
 * every path (no interactive selection possible).
 *
 * @returns The array of selected file paths, or `null` if the user cancelled.
 *          Returns `[]` when there are no staged files.
 */
export async function selectFiles(
	ctx: ExtensionContext,
	nameStatusRaw: string,
): Promise<string[] | null> {
	const entries = parseNameStatus(nameStatusRaw);
	if (entries.length === 0) return [];

	// ── Non‑TUI: show as notification, return everything ──────────────
	if (ctx.mode !== "tui") {
		const fileList = entries
			.map((e) => `  ${e.status}\t${e.path}`)
			.join("\n");
		ctx.ui.notify(`Files to commit:\n${fileList}`, "info");
		return entries.map((e) => e.path);
	}

	// ── TUI: interactive multi‑select ─────────────────────────────────
	const items: FileItem[] = entries.map((e) => ({
		status: e.status,
		path: e.path,
		selected: true,
	}));

	return ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
		let cursor = 0;
		let scrollOffset = 0;
		const maxVisible = Math.min(items.length, 20);

		// Mutable selection copy
		const currentItems = items.map((i) => ({ ...i }));

		return {
			invalidate() {
				// No caching – render always recomputes
			},

			handleInput(data: string) {
				let changed = false;

				if (matchesKey(data, Key.up)) {
					if (cursor > 0) {
						cursor--;
						if (cursor < scrollOffset) scrollOffset = cursor;
						changed = true;
					}
				} else if (matchesKey(data, Key.down)) {
					if (cursor < currentItems.length - 1) {
						cursor++;
						if (cursor >= scrollOffset + maxVisible) {
							scrollOffset = cursor - maxVisible + 1;
						}
						changed = true;
					}
				} else if (matchesKey(data, Key.space)) {
					currentItems[cursor].selected = !currentItems[cursor].selected;
					changed = true;
				} else if (data === "a" || data === "A") {
					const anyUnselected = currentItems.some((i) => !i.selected);
					for (const item of currentItems) {
						item.selected = anyUnselected;
					}
					changed = true;
				} else if (matchesKey(data, Key.enter)) {
					const selected = currentItems
						.filter((i) => i.selected)
						.map((i) => i.path);
					done(selected.length > 0 ? selected : []);
					return;
				} else if (
					matchesKey(data, Key.escape) ||
					matchesKey(data, Key.ctrl("c"))
				) {
					done(null);
					return;
				}

				if (changed) {
					tui.requestRender();
				}
			},

			render(width: number): string[] {
				const lines: string[] = [];

				// ── Title line ──────────────────────────────────────────
				const selectedCount = currentItems.filter((i) => i.selected).length;
				const title = theme.fg(
					"accent",
					theme.bold(
						` Select files to commit  (${selectedCount}/${currentItems.length})`,
					),
				);
				lines.push(title);
				lines.push("");

				// ── Header ──────────────────────────────────────────────
				const header = theme.fg("dim", "   select  type  file");
				lines.push(header);
				lines.push(theme.fg("dim", "  ────── ──── ────"));

				// ── File entries ────────────────────────────────────────
				const visibleItems = currentItems.slice(
					scrollOffset,
					scrollOffset + maxVisible,
				);

				for (let i = 0; i < visibleItems.length; i++) {
					const item = visibleItems[i];
					const idx = scrollOffset + i;
					const isCursor = idx === cursor;

					const cursorMark = isCursor ? theme.fg("accent", "▸") : " ";
					const checkbox = item.selected
						? theme.fg("success", "●")
						: theme.fg("dim", "○");
					const statusColor = STATUS_COLORS[item.status] ?? "muted";
					const statusLabel =
						STATUS_LABELS[item.status] ?? item.status;
					const statusStr = theme.fg(statusColor, statusLabel.padEnd(3));

					const line = `${cursorMark} ${checkbox} ${statusStr} ${item.path}`;
					lines.push(truncateToWidth(line, width));
				}

				// ── Scroll hint ────────────────────────────────────────
				if (currentItems.length > maxVisible) {
					const end = Math.min(
						scrollOffset + maxVisible,
						currentItems.length,
					);
					const hint = theme.fg(
						"dim",
						`  (${scrollOffset + 1}–${end}/${currentItems.length})`,
					);
					lines.push(hint);
				}

				lines.push("");
				// ── Help bar ────────────────────────────────────────────
				lines.push(
					theme.fg(
						"dim",
						"  ↑↓ navigate  space toggle  a select/deselect all  enter commit  esc cancel",
					),
				);

				return lines;
			},
		};
	});
}
