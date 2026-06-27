import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { runCommitPipeline } from "./pipeline.js";
import { parseCommitArgs } from "./args.js";
import { confirmCommitMessage } from "./confirmation.js";
import { GitOperations } from "./git-operations.js";
import { checkCritAvailable, runCritReview } from "./reviewer.js";

/**
 * pi-git extension — `/commit` and `/review` commands
 *
 * Stages all current files, generates a Conventional Commits message,
 * and commits. The heavy lifting is delegated to `runCommitPipeline`
 * in `pipeline.ts`; this module only registers commands and events.
 */
export default function (pi: ExtensionAPI) {
	/**
	 * Update the footer status to show whether there are uncommitted changes.
	 * Shows "[has changes]" when changes exist, clears it otherwise.
	 */
	async function updateFooterStatus(ctx: ExtensionContext) {
		const git = new GitOperations(pi);
		try {
			if (!(await git.isInsideGitRepo())) {
				ctx.ui.setStatus("pi-git-uncommitted", undefined);
				return;
			}
			const hasChanges = await git.checkUncommittedChanges();
			ctx.ui.setStatus(
				"pi-git-uncommitted",
				hasChanges ? "[has changes]" : undefined,
			);
		} catch {
			ctx.ui.setStatus("pi-git-uncommitted", undefined);
		}
	}

	// ───────────────────────────────────────────────────────
	// /commit command
	// ───────────────────────────────────────────────────────

	pi.registerCommand("commit", {
		description: "Stage all changes and generate a Conventional Commits message",
		handler: async (args, ctx) => {
			const { dryRun, inlineMessage } = parseCommitArgs(args?.trim() ?? "");
			const config = loadConfig(ctx.cwd);

			try {
				await runCommitPipeline(pi, ctx, config, {
					inlineMessage,
					dryRun,
					confirmLabel: "commit",
					hooks: {
						onMessageGenerated: async (msg) =>
							inlineMessage
								? { action: "commit" }
								: confirmCommitMessage(ctx, msg, "pi-git-commit", dryRun),
					},
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Commit error: ${message}`, "error");
			}
		},
	});

	// ───────────────────────────────────────────────────────
	// /review command
	// ───────────────────────────────────────────────────────

	pi.registerCommand("review", {
		description:
			"Stage, review with crit, generate commit message, and commit",
		handler: async (args, ctx) => {
			const { dryRun } = parseCommitArgs(args?.trim() ?? "");
			const config = loadConfig(ctx.cwd);

			try {
				await checkCritAvailable(pi);

				await runCommitPipeline(pi, ctx, config, {
					dryRun,
					confirmLabel: "review",
					hooks: {
						onBeforeGenerate: async (pipelineCtx, opts) => {
							// Build per-file entries for the crit review document
							const fileEntries = pipelineCtx.selectedFiles
								.map((path) => {
									const detail = pipelineCtx.fileDetails?.get(path);
									return detail
										? {
												path,
												additions: detail.additions,
												deletions: detail.deletions,
											}
										: null;
								})
								.filter(
									(e): e is NonNullable<typeof e> => e !== null,
								);

							// Run crit review
							ctx.ui.notify(
								"Opening crit review in your browser. Review the diff and click Finish Review when done.",
								"info",
							);
							const result = await runCritReview(
								pipelineCtx.pi,
								pipelineCtx.stagedDiff,
								fileEntries,
							);

							// Handle unresolved comments
							const unresolvedComments = result.comments.filter(
								(c) => !c.resolved,
							);
							let reviewContext: string | undefined;

							if (unresolvedComments.length > 0) {
								const commentSummary = unresolvedComments
									.map((c) => {
										const location = c.file
											? `${c.file}${c.quote ? `: "${c.quote}"` : ""}`
											: "";
										return location
											? `${location}: ${c.body}`
											: c.body;
									})
									.join("\n");

								ctx.ui.notify(
									`Unresolved review comments:\n${commentSummary}`,
									"warning",
								);

								if (ctx.hasUI) {
									const choice = await ctx.ui.select(
										"Review has unresolved comments. Continue with commit?",
										[
											"Yes — include comments in commit message context",
											"No — cancel and fix issues first",
										],
									);
									if (
										choice !==
										"Yes — include comments in commit message context"
									) {
										throw new Error(
											"Review cancelled by user — fix issues first.",
										);
									}
								}

								reviewContext = commentSummary;
							}

							// Pass review context to LLM generation
							if (reviewContext) {
								opts.llmExtraContext = reviewContext;
							}
						},
						onMessageGenerated: async (msg) =>
							confirmCommitMessage(
								ctx,
								msg,
								"pi-git-review-msg",
								dryRun,
							),
					},
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				if (message.includes("cancelled")) {
					ctx.ui.notify(message, "info");
				} else {
					ctx.ui.notify(`Review error: ${message}`, "error");
				}
			}
		},
	});

	// ───────────────────────────────────────────────────────
	// Show uncommitted changes indicator in footer
	// ───────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		await updateFooterStatus(ctx);
	});

	// ───────────────────────────────────────────────────────
	// Auto-commit on agent_end (commit_every_turn)
	// ───────────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);

		if (!config.commitEveryTurn) {
			await updateFooterStatus(ctx);
			return;
		}

		try {
			await runCommitPipeline(pi, ctx, config, {
				skipFileSelection: true,
				// No hooks → onMessageGenerated undefined → commit without confirmation
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`commit_every_turn: error — ${message}`,
				"error",
			);
		}
	});
}
