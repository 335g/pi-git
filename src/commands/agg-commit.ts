/**
 * /git-agg-commit command
 *
 * Automatically analyzes git diff, splits into logical hunks,
 * generates Conventional Commits messages, stages, and commits.
 *
 * With --review flag: opens an interactive overlay where the user can
 * inspect, edit, and exclude hunks before committing.
 *
 * In accumulate mode (auto_agg_commit_mode = "accumulate"):
 * delegates to batch-committer which injects TurnLog context into the AI prompt.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { analyzeDiff, processHunks } from "../core/diff-analyzer.js";
import {
  collectDiff,
  ensureReadyToCommit,
  resetStaging,
} from "../core/git.js";
import { runHunkReview } from "../core/review.js";
import { sanitizeCommitMessage } from "../core/commit-message.js";
import { commitHunks } from "../core/commit-hunks.js";
import { batchCommitWithCleanup } from "../core/batch-committer.js";
import { getAutoAggCommitMode } from "../utils/settings.js";
import { turnLog } from "../core/turn-log.js";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";

function parseLangArg(args: string): string | undefined {
  const match = args.match(/--lang(?:uage)?[=\s]+(\S+)/);
  return match?.[1];
}

function parseReviewFlag(args: string): boolean {
  return /(?:^|\s)--review(?:\s|$)/.test(args);
}

export async function handleAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const lang = getLanguage(ctx.cwd);

  if (/--help/.test(args)) {
    if (ctx.hasUI) {
      ctx.ui.notify(t(lang, "aggCommit.help"), "info");
    }
    return;
  }

  // Parse language argument (temporary override, does not save)
  const langArg = parseLangArg(args);
  const runLang = langArg ?? lang;
  const isReview = parseReviewFlag(args);
  if (langArg) {
    ctx.ui.notify(
      t(runLang, "aggCommit.langOverride", { lang: langArg }),
      "info",
    );
  }

  if (!ctx.hasUI) {
    return;
  }

  if (footerManager.isRunning()) {
    ctx.ui.notify(t(runLang, "aggCommit.alreadyRunning"), "warning");
    return;
  }

  // ── accumulate モード: batch-committer に全委譲 ──
  const mode = getAutoAggCommitMode(ctx.cwd);
  if (mode === "accumulate" && turnLog.turnCount > 0) {
    try {
      await footerManager.setRunning("agg-commit", "prepare", runLang);

      const preCheck = await ensureReadyToCommit(pi, ctx.cwd);
      if (preCheck) {
        const key =
          preCheck === "not_git_repo"
            ? "aggCommit.notGitRepo"
            : preCheck === "merge_conflict"
              ? "aggCommit.mergeConflict"
              : "aggCommit.noChanges";
        const level =
          preCheck === "merge_conflict"
            ? "error"
            : preCheck === "not_git_repo"
              ? "warning"
              : "info";
        ctx.ui.notify(t(runLang, key), level);
        return;
      }

      const { committed, failed, skipped, aborted } =
        await batchCommitWithCleanup(pi, ctx, runLang, isReview);

      // Summary notification
      const parts: string[] = [];
      if (committed > 0) {
        parts.push(
          t(runLang, "aggCommit.summaryCommitted", {
            count: String(committed),
          }),
        );
      }
      if (skipped > 0) {
        parts.push(
          t(runLang, "aggCommit.summarySkipped", {
            count: String(skipped),
          }),
        );
      }
      if (failed > 0) {
        parts.push(
          t(runLang, "aggCommit.summaryFailed", {
            count: String(failed),
          }),
        );
      }
      if (aborted > 0) {
        parts.push(
          t(runLang, "aggCommit.summaryAborted", {
            remaining: String(aborted),
          }),
        );
      }

      if (parts.length === 0) {
        ctx.ui.notify(t(runLang, "aggCommit.summaryAllFailed"), "error");
      } else if (failed > 0) {
        ctx.ui.notify(parts.join(", "), "warning");
      } else {
        ctx.ui.notify(parts.join(", "), "info");
      }
      return;
    } finally {
      await footerManager.clearRunning();
    }
  }

  // ── per_turn モード: 既存フロー ──

  try {
    await footerManager.setRunning("agg-commit", "prepare", runLang);

    const preCheck = await ensureReadyToCommit(pi, ctx.cwd);
    if (preCheck) {
      const key =
        preCheck === "not_git_repo"
          ? "aggCommit.notGitRepo"
          : preCheck === "merge_conflict"
            ? "aggCommit.mergeConflict"
            : "aggCommit.noChanges";
      const level =
        preCheck === "merge_conflict"
          ? "error"
          : preCheck === "not_git_repo"
            ? "warning"
            : "info";
      ctx.ui.notify(t(runLang, key), level);
      return;
    }

    // Snapshot changes via stash (SHA-based diff capture — no reflog race)
    await footerManager.setPhase("collectDiff", runLang);
    const diff = await collectDiff(pi, ctx.cwd);
    if (diff === null) {
      ctx.ui.notify(t(runLang, "aggCommit.stashFailed"), "warning");
      return;
    }
    if (!diff.trim()) {
      ctx.ui.notify(t(runLang, "aggCommit.noChanges"), "info");
      return;
    }

    // Analyze diff into logical hunks (with TurnLog if available)
    await footerManager.setPhase("analyze", runLang);
    const turnLogText = turnLog.formatForPrompt();
    let hunks = await analyzeDiff(
      pi,
      ctx,
      diff,
      runLang,
      turnLogText || undefined,
    );
    if (hunks.length === 0) {
      ctx.ui.notify(t(runLang, "aggCommit.noHunksFound"), "info");
      return;
    }

    // Sanitize, deduplicate, and filter hunks
    await footerManager.setPhase("generateMessage", runLang);
    hunks = processHunks(hunks);

    // ── Review mode: interactive hunk review ──────────────────
    if (isReview) {
      const reviewResult = await runHunkReview(ctx, hunks, diff, runLang);
      if (reviewResult === null) {
        return; // cancelled — no commits
      }
      // Only commit included hunks, re-sanitize user-edited messages
      hunks = reviewResult.hunks
        .filter((h) => h.included)
        .map((h) => ({
          ...h,
          message: sanitizeCommitMessage(h.message, h.files),
        }));
      if (hunks.length === 0) {
        ctx.ui.notify(t(runLang, "review.noHunksSelected"), "info");
        return;
      }
    }

    // Stage and commit each hunk
    await footerManager.setPhase("commit", runLang);
    const { committed, failed, skipped, aborted } = await commitHunks(
      pi,
      ctx,
      hunks,
      runLang,
    );

    const parts: string[] = [];
    if (committed > 0) {
      parts.push(
        t(runLang, "aggCommit.summaryCommitted", {
          count: String(committed),
        }),
      );
    }
    if (skipped > 0) {
      parts.push(
        t(runLang, "aggCommit.summarySkipped", {
          count: String(skipped),
        }),
      );
    }
    if (failed > 0) {
      parts.push(
        t(runLang, "aggCommit.summaryFailed", {
          count: String(failed),
        }),
      );
    }
    if (aborted > 0) {
      parts.push(
        t(runLang, "aggCommit.summaryAborted", {
          remaining: String(aborted),
        }),
      );
    }

    if (parts.length === 0) {
      ctx.ui.notify(t(runLang, "aggCommit.summaryAllFailed"), "error");
    } else if (failed > 0) {
      ctx.ui.notify(parts.join(", "), "warning");
    } else {
      ctx.ui.notify(parts.join(", "), "info");
    }
  } finally {
    // Final cleanup: ensure staging area is clean
    try {
      await resetStaging(pi, ctx.cwd);
    } catch {
      /* ignore */
    }
    await footerManager.clearRunning();
  }
}
