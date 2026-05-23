/**
 * pi-git extension entry point
 *
 * Provides slash commands for git operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleAggCommit } from "./commands/agg-commit.js";

export default function (pi: ExtensionAPI) {
	// Register /git-agg-commit command
	pi.registerCommand("git-agg-commit", {
		description: "Auto stage and commit changes with AI-generated Conventional Commits messages",
		handler: async (args, ctx) => {
			await handleAggCommit(pi, ctx, args);
		},
	});
}
