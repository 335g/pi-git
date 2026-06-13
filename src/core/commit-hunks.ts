/**
 * Shared commit-hunks utility.
 *
 * Extracted from agg-commit.ts to be reusable by batch-committer.ts.
 * Commits hunks sequentially with per-hunk staging and progress updates.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Hunk, DiffHunk, CommitGroup } from "../types.js";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";
import { resetStaging, stageFiles, stageDiffHunks } from "./git.js";

/**
 * Commit hunks sequentially.
 *
 * Each hunk is staged and committed independently. If staging fails for one
 * hunk, it is skipped and the next hunk is attempted. If resetStaging fails,
 * the entire batch is aborted (staging area is potentially corrupted).
 *
 * @param lang - Optional language override (defaults to repo language)
 */
export async function commitHunks(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  hunks: Hunk[],
  lang?: string,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
}> {
  const runLang = lang ?? getLanguage(ctx.cwd);
  let committedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const total = hunks.length;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!;
    await footerManager.setCommitProgress(i + 1, hunks.length);

    // Ensure clean staging area before each hunk
    try {
      await resetStaging(pi, ctx.cwd);
    } catch {
      ctx.ui.notify(t(runLang, "aggCommit.stagingResetFailed"), "error");
      failedCount++;
      const remaining = total - (i + 1);
      return {
        committed: committedCount,
        failed: failedCount,
        skipped: skippedCount,
        aborted: remaining,
      };
    }

    try {
      await stageFiles(pi, hunk.files, ctx.cwd);
    } catch {
      failedCount++;
      continue;
    }

    const { stdout: stagedDiff, code: diffCode } = await pi.exec(
      "git",
      ["diff", "--cached", "--stat"],
      { cwd: ctx.cwd },
    );
    if (diffCode !== 0 || !stagedDiff.trim()) {
      skippedCount++;
      continue;
    }

    const { code: exitCode, stderr } = await pi.exec(
      "git",
      ["commit", "-m", hunk.message],
      { cwd: ctx.cwd },
    );
    if (exitCode !== 0) {
      const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
      ctx.ui.notify(
        t(runLang, "aggCommit.commitFailed", {
          message: hunk.message,
          exitCode: String(exitCode),
        }) + detail,
        "warning",
      );
      failedCount++;
      continue;
    }

    committedCount++;
  }

  return {
    committed: committedCount,
    failed: failedCount,
    skipped: skippedCount,
    aborted: 0,
  };
}

/**
 * Commit groups (intent-based hunk splitting results) sequentially.
 *
 * Uses stageDiffHunks for partial-file staging when a group contains
 * only some hunks from a file. Files where all hunks are in the group
 * use fast-path git add.
 *
 * Falls back to file-level staging when diffHunks is unavailable.
 */
export async function commitCommitGroups(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  groups: CommitGroup[],
  diffHunks: DiffHunk[],
  lang?: string,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
}> {
  const runLang = lang ?? getLanguage(ctx.cwd);
  let committedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const total = groups.length;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    await footerManager.setCommitProgress(i + 1, groups.length);

    // Ensure clean staging area before each commit
    try {
      await resetStaging(pi, ctx.cwd);
    } catch {
      ctx.ui.notify(t(runLang, "aggCommit.stagingResetFailed"), "error");
      failedCount++;
      const remaining = total - (i + 1);
      return {
        committed: committedCount,
        failed: failedCount,
        skipped: skippedCount,
        aborted: remaining,
      };
    }

    try {
      if (group.hunks.length > 0 && diffHunks.length > 0) {
        // Intent-based path: stage only the hunks in this group
        await stageDiffHunks(pi, diffHunks, group.hunks, ctx.cwd);
      } else {
        // Fallback: no hunk refs — nothing to stage
        skippedCount++;
        continue;
      }
    } catch {
      failedCount++;
      continue;
    }

    const { stdout: stagedDiff, code: diffCode } = await pi.exec(
      "git",
      ["diff", "--cached", "--stat"],
      { cwd: ctx.cwd },
    );
    if (diffCode !== 0 || !stagedDiff.trim()) {
      skippedCount++;
      continue;
    }

    const { code: exitCode, stderr } = await pi.exec(
      "git",
      ["commit", "-m", group.message],
      { cwd: ctx.cwd },
    );
    if (exitCode !== 0) {
      const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
      ctx.ui.notify(
        t(runLang, "aggCommit.commitFailed", {
          message: group.message,
          exitCode: String(exitCode),
        }) + detail,
        "warning",
      );
      failedCount++;
      continue;
    }

    committedCount++;
  }

  return {
    committed: committedCount,
    failed: failedCount,
    skipped: skippedCount,
    aborted: 0,
  };
}
