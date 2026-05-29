/**
 * /git-diff command
 *
 * Interactive diff review with sequential hunk approval.
 * Allows reviewing AI-generated hunks, viewing diffs, editing messages,
 * and committing approved hunks one at a time.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { sanitizeHunk } from "../core/commit-message.js";
import { analyzeDiff } from "../core/diff-analyzer.js";
import {
  hasChanges,
  isGitRepository,
  resetStaging,
  stageFiles,
} from "../core/git.js";
import { isJapanese } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { isAggCommitRunning } from "./agg-commit.js";
import {
  HunkReviewComponent,
  type HunkReviewAction,
  type FileStats,
} from "../tui/hunk-review.js";
import type { Hunk } from "../types.js";

const STATUS_ID = "pi-git-diff";

/**
 * Split a full diff into per-file diffs
 */
function splitDiffByFile(fullDiff: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const lines = fullDiff.split("\n");
  let currentFile: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // Save previous file
      if (currentFile) {
        result.set(currentFile, currentLines);
      }
      // Parse new file path
      const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        currentFile = match[2];
        currentLines = [line];
      }
    } else if (currentFile) {
      currentLines.push(line);
    }
  }

  // Save last file
  if (currentFile) {
    result.set(currentFile, currentLines);
  }

  return result;
}

/**
 * Parse diff stats (additions/deletions) for each file
 */
function parseDiffStats(fullDiff: string): Map<string, FileStats> {
  const result = new Map<string, FileStats>();
  const lines = fullDiff.split("\n");
  let currentFile: string | null = null;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // Save previous file
      if (currentFile) {
        result.set(currentFile, { path: currentFile, additions, deletions });
      }
      // Parse new file path
      const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        currentFile = match[2];
        additions = 0;
        deletions = 0;
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  // Save last file
  if (currentFile) {
    result.set(currentFile, { path: currentFile, additions, deletions });
  }

  return result;
}

/**
 * Review a single hunk using the TUI component
 */
async function reviewHunk(
  ctx: ExtensionCommandContext,
  hunk: Hunk,
  hunkIndex: number,
  totalHunks: number,
  fileStats: Map<string, FileStats>,
  fileDiffs: Map<string, string[]>,
): Promise<HunkReviewAction> {
  if (!ctx.hasUI) {
    return { type: "quit" };
  }

  return await ctx.ui.custom<HunkReviewAction>((tui, theme, _keybindings, done) => {
    const component = new HunkReviewComponent(
      hunk,
      hunkIndex,
      totalHunks,
      fileStats,
      fileDiffs,
      tui,
      theme,
      done,
    );
    return component;
  });
}

export async function handleGitDiff(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const lang = getLanguage(ctx.cwd);
  const ja = isJapanese(lang);

  if (/--help/.test(args)) {
    const lines = ja
      ? [
          "/git-diff [--help]",
          "",
          "AIが生成したhunkを対話的にレビューし、承認したものをコミットします。",
          "",
          "オプション:",
          "  --help  このヘルプを表示",
          "",
          "操作:",
          "  ↑↓        ファイル間を移動",
          "  Enter     選択したファイルのdiffを表示",
          "  a         hunkを承認してコミット",
          "  e         コミットメッセージを編集",
          "  s         hunkをスキップ",
          "  x         選択したファイルをhunkから除外",
          "  q         終了",
        ]
      : [
          "/git-diff [--help]",
          "",
          "Interactively review AI-generated hunks and commit approved ones.",
          "",
          "Options:",
          "  --help  Show this help message",
          "",
          "Controls:",
          "  ↑↓        Navigate between files",
          "  Enter     View diff for selected file",
          "  a         Approve and commit hunk",
          "  e         Edit commit message",
          "  s         Skip hunk",
          "  x         Exclude selected file from hunk",
          "  q         Quit",
        ];
    if (ctx.hasUI) {
      ctx.ui.notify(lines.join("\n"), "info");
    }
    return;
  }

  if (!ctx.hasUI) {
    return;
  }

  // Check if agg-commit is running
  if (isAggCommitRunning) {
    ctx.ui.notify(
      ja
        ? "git-agg-commit 実行中です。完了してから再度実行してください。"
        : "git-agg-commit is already running. Please wait for it to complete.",
      "warning",
    );
    return;
  }

  ctx.ui.setStatus(STATUS_ID, ja ? "[pi-git] 準備中..." : "[pi-git] Preparing...");

  try {
    // Check git repository
    if (!(await isGitRepository(pi, ctx.cwd))) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        ja ? "Gitリポジトリではありません" : "Not a git repository",
        "warning",
      );
      return;
    }

    // Check for changes
    if (!(await hasChanges(pi, ctx.cwd))) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        ja ? "コミットする変更がありません" : "No changes to commit",
        "info",
      );
      return;
    }

    // Collect diff using stash pattern
    ctx.ui.setStatus(
      STATUS_ID,
      ja ? "[pi-git] diff収集中..." : "[pi-git] Collecting diff...",
    );

    const { code: stashCode } = await pi.exec(
      "git",
      ["stash", "push", "-u", "-m", "pi-git-diff"],
      { cwd: ctx.cwd },
    );
    if (stashCode !== 0) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        ja ? "変更のstashに失敗しました" : "Failed to stash changes",
        "warning",
      );
      return;
    }

    let diff = "";
    try {
      const { stdout: stashDiff } = await pi.exec(
        "git",
        ["stash", "show", "-p", "stash@{0}"],
        { cwd: ctx.cwd },
      );
      diff = stashDiff;

      // Include untracked files
      const { stdout: untrackedDiff, code: untrackedCode } = await pi.exec(
        "git",
        ["diff", "HEAD", "stash@{0}^3"],
        { cwd: ctx.cwd },
      );
      if (untrackedCode === 0 && untrackedDiff.trim()) {
        diff += (diff ? "\n" : "") + untrackedDiff;
      }
    } finally {
      await pi.exec("git", ["stash", "pop"], { cwd: ctx.cwd });
    }

    if (!diff.trim()) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        ja ? "コミットする変更がありません" : "No changes to commit",
        "info",
      );
      return;
    }

    // Parse diff by file
    const fileDiffs = splitDiffByFile(diff);
    const fileStats = parseDiffStats(diff);

    // Analyze diff into hunks
    ctx.ui.setStatus(
      STATUS_ID,
      ja ? "[pi-git] hunk解析中..." : "[pi-git] Analyzing hunks...",
    );

    let hunks = await analyzeDiff(pi, ctx, diff);
    if (hunks.length === 0) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        ja ? "コミット可能なhunkがありません" : "No hunks found to commit",
        "info",
      );
      return;
    }

    // Sanitize commit messages
    hunks = hunks.map(sanitizeHunk);

    // Deduplicate files across hunks
    const seenFiles = new Set<string>();
    hunks = hunks
      .map((hunk) => ({
        ...hunk,
        files: hunk.files.filter((f) => {
          if (seenFiles.has(f)) return false;
          seenFiles.add(f);
          return true;
        }),
      }))
      .filter((hunk) => hunk.files.length > 0);

    ctx.ui.setStatus(STATUS_ID, "");

    // Review each hunk sequentially
    const unassignedFiles: string[] = [];
    let committedCount = 0;
    let skippedCount = 0;

    let quitRequested = false;

    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      let currentMessage = hunk.message;

      // Review loop (for message editing)
      while (true) {
        const action = await reviewHunk(
          ctx,
          { ...hunk, message: currentMessage },
          i,
          hunks.length,
          fileStats,
          fileDiffs,
        );

        if (action.type === "quit") {
          // Add current and remaining hunks' files to unassigned
          for (let j = i; j < hunks.length; j++) {
            unassignedFiles.push(...hunks[j].files);
          }
          quitRequested = true;
          break;
        }

        if (action.type === "edit_message") {
          // Edit message using pi's built-in input dialog (IME-supported)
          const newMessage = await ctx.ui.input(
            ja ? "コミットメッセージを編集:" : "Edit commit message:",
            action.currentMessage,
          );
          if (newMessage && newMessage.trim()) {
            currentMessage = newMessage.trim();
          }
          // Continue loop to re-show the hunk with updated message
          continue;
        }

        if (action.type === "skip") {
          // Add non-excluded files to unassigned
          const files = hunk.files.filter(
            (f) => !action.excludedFiles.includes(f),
          );
          unassignedFiles.push(...files, ...action.excludedFiles);
          skippedCount++;
          break;
        }

        if (action.type === "approve") {
          // Stage and commit non-excluded files
          const files = hunk.files.filter(
            (f) => !action.excludedFiles.includes(f),
          );

          if (files.length === 0) {
            ctx.ui.notify(
              ja
                ? "コミットするファイルがありません"
                : "No files to commit",
              "warning",
            );
            break;
          }

          try {
            await stageFiles(pi, files, ctx.cwd);
          } catch (error) {
            ctx.ui.notify(
              ja
                ? `ファイルのステージに失敗しました: ${error instanceof Error ? error.message : String(error)}`
                : `Failed to stage files: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            break;
          }

          const { code: exitCode, stderr } = await pi.exec(
            "git",
            ["commit", "-m", action.message],
            { cwd: ctx.cwd },
          );

          if (exitCode !== 0) {
            try {
              await resetStaging(pi, ctx.cwd);
            } catch {
              // Ignore reset errors
            }
            const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
            ctx.ui.notify(
              ja
                ? `コミットに失敗しました: "${action.message}" (exit code ${exitCode})${detail}。ステージをリセットしました。`
                : `Commit failed for "${action.message}" (exit code ${exitCode}).${detail} Staging has been reset.`,
              "warning",
            );
            break;
          }

          committedCount++;

          // Add excluded files to unassigned
          unassignedFiles.push(...action.excludedFiles);
          break;
        }
      }

      if (quitRequested) break;
    }

    // Show summary
    const parts: string[] = [];
    if (committedCount > 0) {
      parts.push(
        ja
          ? `${committedCount}個のhunkをコミットしました`
          : `Committed ${committedCount} hunk${committedCount > 1 ? "s" : ""}`,
      );
    }
    if (skippedCount > 0) {
      parts.push(
        ja
          ? `${skippedCount}個のhunkをスキップしました`
          : `Skipped ${skippedCount} hunk${skippedCount > 1 ? "s" : ""}`,
      );
    }

    if (parts.length > 0) {
      ctx.ui.notify(parts.join(", "), "info");
    }

    // Show unassigned files
    if (unassignedFiles.length > 0) {
      const lines = ja
        ? [
            "",
            `⚠ ${unassignedFiles.length}個のファイルが未割り当てです:`,
            ...unassignedFiles.map((f) => `  ${f}`),
          ]
        : [
            "",
            `⚠ ${unassignedFiles.length} file${unassignedFiles.length > 1 ? "s" : ""} remain unassigned:`,
            ...unassignedFiles.map((f) => `  ${f}`),
          ];
      ctx.ui.notify(lines.join("\n"), "info");
    }
  } finally {
    ctx.ui.setStatus(STATUS_ID, "");
  }
}
