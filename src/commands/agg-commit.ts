/**
 * /git-agg-commit command
 *
 * Automatically analyzes git diff, splits into logical hunks,
 * generates Conventional Commits messages, stages, and commits.
 *
 * Uses accumulated TurnLog conversation context for higher-quality
 * hunk splitting when available.
 *
 * With --review flag: opens an interactive overlay where the user can
 * inspect, edit, and exclude hunks before committing.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  collectDiff,
  ensureReadyToCommit,
  resetStaging,
} from "../core/git.js";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";
import { batchCommitWithCleanup } from "../core/batch-committer.js";

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

  const langArg = parseLangArg(args);
  const runLang = langArg ?? lang;
  const isReview = parseReviewFlag(args);
  if (langArg) {
    ctx.ui.notify(
      t(runLang, "aggCommit.langOverride", { lang: langArg }),
      "info",
    );
  }

  if (!ctx.hasUI) return;

  if (footerManager.isRunning()) {
    ctx.ui.notify(t(runLang, "aggCommit.alreadyRunning"), "warning");
    return;
  }

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

    const parts: string[] = [];
    if (committed > 0) {
      parts.push(
        t(runLang, "aggCommit.summaryCommitted", { count: String(committed) }),
      );
    }
    if (skipped > 0) {
      parts.push(
        t(runLang, "aggCommit.summarySkipped", { count: String(skipped) }),
      );
    }
    if (failed > 0) {
      parts.push(
        t(runLang, "aggCommit.summaryFailed", { count: String(failed) }),
      );
    }
    if (aborted > 0) {
      parts.push(
        t(runLang, "aggCommit.summaryAborted", { remaining: String(aborted) }),
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
    try {
      await resetStaging(pi, ctx.cwd);
    } catch {
      /* ignore */
    }
    await footerManager.clearRunning();
  }
}
