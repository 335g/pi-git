/**
 * Batch commit flow for accumulate mode.
 *
 * Called from /git-agg-commit when auto_agg_commit_mode is "accumulate".
 * Collects diff, injects TurnLog into AI prompt, splits into hunks, and commits.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";
import { analyzeDiff, processHunks } from "./diff-analyzer.js";
import { collectDiff, hasChanges, resetStaging } from "./git.js";
import { commitHunks } from "./commit-hunks.js";
import { runHunkReview } from "./review.js";
import { turnLog } from "./turn-log.js";

/**
 * Execute a batch commit using the accumulated TurnLog for context.
 *
 * @param pi - Extension API
 * @param ctx - Command context
 * @param langOverride - Optional language override (from --lang flag)
 * @param isReview - If true, show the interactive hunk review dialog
 */
export async function batchCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  langOverride?: string,
  isReview = false,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
  message: string;
}> {
  const lang = langOverride ?? getLanguage(ctx.cwd);

  // 1. Pre-flight checks
  await footerManager.setPhase("collectDiff", lang);

  if (!(await hasChanges(pi))) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noChanges"),
    };
  }

  const diff = await collectDiff(pi, ctx.cwd);
  if (diff === null) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.stashFailed"),
    };
  }
  if (!diff.trim()) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noChanges"),
    };
  }

  // 2. Analyze diff with TurnLog context
  await footerManager.setPhase("analyze", lang);

  const turnLogText = turnLog.formatForPrompt();
  const hunks = await analyzeDiff(
    pi,
    ctx,
    diff,
    lang,
    turnLogText || undefined,
  );

  if (hunks.length === 0) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noHunksFound"),
    };
  }

  // 3. Process hunks (sanitize, dedup, generic-message check)
  await footerManager.setPhase("generateMessage", lang);
  const processed = processHunks(hunks);

  if (processed.length === 0) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noHunksFound"),
    };
  }

  // 4. Review (if requested)
  if (isReview) {
    const reviewResult = await runHunkReview(ctx, processed, diff, lang);
    if (reviewResult === null) {
      // Cancelled
      return {
        committed: 0,
        failed: 0,
        skipped: 0,
        aborted: 0,
        message: t(lang, "review.cancelled"),
      };
    }
    // Only commit included hunks
    const includedHunks = reviewResult.hunks
      .filter((h) => h.included)
      .map((h) => ({
        files: h.files,
        message: h.message,
      }));
    if (includedHunks.length === 0) {
      return {
        committed: 0,
        failed: 0,
        skipped: 0,
        aborted: 0,
        message: t(lang, "review.noHunksSelected"),
      };
    }
    // Commit with reviewed hunks
    await footerManager.setPhase("commit", lang);
    const result = await commitHunks(pi, ctx, includedHunks, lang);
    return { ...result, message: "committed" };
  }

  // 5. Commit all hunks
  await footerManager.setPhase("commit", lang);
  const result = await commitHunks(pi, ctx, processed, lang);
  return { ...result, message: "committed" };
}

/**
 * Convenience wrapper: run batch commit with cleanup.
 * Clears TurnLog after commit attempt and resets staging area.
 */
export async function batchCommitWithCleanup(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  langOverride?: string,
  isReview = false,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
  message: string;
}> {
  try {
    const result = await batchCommit(pi, ctx, langOverride, isReview);

    // Clear TurnLog after commit attempt (unconditional — diff is primary)
    turnLog.clear();

    return result;
  } finally {
    // Final cleanup: ensure staging area is clean
    try {
      await resetStaging(pi, ctx.cwd);
    } catch {
      /* ignore */
    }
  }
}
