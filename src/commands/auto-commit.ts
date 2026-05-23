/**
 * /git-auto-commit command
 *
 * Automatically analyzes git diff, splits into logical hunks,
 * generates Conventional Commits messages, stages, and commits.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	isGitRepository,
	hasChanges,
	stageFiles,
	commit,
	resetStaging,
} from "../core/git.js";
import { analyzeDiff } from "../core/diff-analyzer.js";
import { sanitizeHunk } from "../core/commit-message.js";

export async function handleAutoCommit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	// 1. Skip in non-interactive mode
	if (!ctx.hasUI) {
		return;
	}

	// 2. Check git repository
	if (!(await isGitRepository(pi))) {
		ctx.ui.notify("Not a git repository", "warning");
		return;
	}

	// 3. Check for changes
	if (!(await hasChanges(pi))) {
		ctx.ui.notify("No changes to commit", "info");
		return;
	}

	// 4. Get full diff including tracked changes and untracked files
	const { stdout: trackedDiff, code: trackedCode } = await pi.exec("git", ["diff", "HEAD"]);
	if (trackedCode !== 0) {
		ctx.ui.notify("Failed to get diff", "warning");
		return;
	}

	// Collect untracked files
	const { stdout: untrackedFiles } = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"]);
	let untrackedDiff = "";
	for (const file of untrackedFiles.split("\n").filter((f) => f.trim())) {
		const { stdout: content } = await pi.exec("cat", [file]);
		untrackedDiff += `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split("\n").length} @@\n`;
		for (const line of content.split("\n")) {
			untrackedDiff += `+${line}\n`;
		}
	}

	const diff = trackedDiff + untrackedDiff;
	if (!diff.trim()) {
		ctx.ui.notify("No changes to commit", "info");
		return;
	}

	// 5. Analyze diff into logical hunks
	let hunks = await analyzeDiff(pi, ctx, diff);
	if (hunks.length === 0) {
		ctx.ui.notify("No hunks found to commit", "info");
		return;
	}

	// 6. Sanitize commit messages
	hunks = hunks.map(sanitizeHunk);

	// 7. Stage and commit each hunk
	let committedCount = 0;
	let failedCount = 0;

	for (const hunk of hunks) {
		// Stage files for this hunk
		try {
			await stageFiles(pi, hunk.files);
		} catch (error) {
			ctx.ui.notify(
				`Failed to stage files: ${hunk.files.join(", ")}`,
				"warning",
			);
			failedCount++;
			continue;
		}

		// Commit
		const exitCode = await commit(pi, hunk.message);
		if (exitCode !== 0) {
			// Pre-commit hook failed or other error - reset staging
			try {
				await resetStaging(pi);
			} catch {
				// Ignore reset errors
			}
			ctx.ui.notify(
				`Commit failed for "${hunk.message}" (exit code ${exitCode}). Staging has been reset.`,
				"warning",
			);
			failedCount++;
			continue;
		}

		committedCount++;
	}

	// 8. Notify completion
	if (committedCount > 0 && failedCount === 0) {
		ctx.ui.notify(
			`Created ${committedCount} commit${committedCount > 1 ? "s" : ""}`,
			"info",
		);
	} else if (committedCount > 0 && failedCount > 0) {
		ctx.ui.notify(
			`Created ${committedCount} commit${committedCount > 1 ? "s" : ""}, ${failedCount} failed`,
			"warning",
		);
	} else {
		ctx.ui.notify("All commits failed", "error");
	}
}
