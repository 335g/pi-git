/**
 * pi-git extension entry point
 *
 * Provides slash commands for git operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleAggCommit, isAggCommitRunning } from "./commands/agg-commit.js";
import { handleAutoAggCommit } from "./commands/auto-agg-commit.js";
import { isGitRepository, hasChanges } from "./core/git.js";
import { getAutoAggCommit } from "./utils/settings.js";
import { updateAutoAggCommitStatus } from "./utils/status.js";

export default function (pi: ExtensionAPI) {
	// Initialize status on session start
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			updateAutoAggCommitStatus(ctx.ui, getAutoAggCommit());
		}
	});

	// Register /git-agg-commit command
	pi.registerCommand("git-agg-commit", {
		description: "Auto stage and commit changes with AI-generated Conventional Commits messages",
		handler: async (args, ctx) => {
			await handleAggCommit(pi, ctx, args);
		},
	});

	// Register /git-auto-agg-commit command
	pi.registerCommand("git-auto-agg-commit", {
		description: "Toggle automatic git-agg-commit after assistant responses",
		handler: async (args, ctx) => {
			await handleAutoAggCommit(pi, ctx, args);
		},
	});

	// Auto-run git-agg-commit after assistant response when enabled
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		if (isAggCommitRunning) {
			return;
		}

		if (!getAutoAggCommit()) {
			return;
		}

		if (!(await isGitRepository(pi))) {
			return;
		}

		if (!(await hasChanges(pi))) {
			return;
		}

		await handleAggCommit(pi, ctx, "");
	});
}
