/**
 * /git-agg-commit command
 *
 * Automatically analyzes git diff, splits into logical hunks,
 * generates Conventional Commits messages, stages, and commits.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
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
import { getAutoAggCommit, getLanguage } from "../utils/settings.js";
import {
  clearAutoAggCommitStatus,
  restoreAutoAggCommitStatus,
} from "../utils/status.js";

export let isAggCommitRunning = false;

/** Set the agg-commit running flag from external modules */
export function setAggCommitRunning(value: boolean): void {
  isAggCommitRunning = value;
}

const STATUS_ID = "pi-git-agg-commit";

function parseLangArg(args: string): string | undefined {
  const match = args.match(/--lang(?:uage)?[=\s]+(\S+)/);
  return match?.[1];
}

function statusText(
  lang: string,
  key: "prepare" | "collectDiff" | "analyze" | "generateMessage" | "commit",
  autoCommit: boolean,
): string {
  const ja = isJapanese(lang);
  const prefix = autoCommit ? "[pi-git: auto-commit]" : "[pi-git]";
  switch (key) {
    case "prepare":
      return ja ? `${prefix} 準備中...` : `${prefix} Preparing...`;
    case "collectDiff":
      return ja ? `${prefix} diff収集中...` : `${prefix} Collecting diff...`;
    case "analyze":
      return ja ? `${prefix} hunk解析中...` : `${prefix} Analyzing hunks...`;
    case "generateMessage":
      return ja
        ? `${prefix} コミットメッセージ生成中...`
        : `${prefix} Generating messages...`;
    case "commit":
      return ja ? `${prefix} コミット実行中...` : `${prefix} Committing...`;
  }
}

export async function handleAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  const lang = getLanguage(ctx.cwd);
  const ja = isJapanese(lang);

  if (/--help/.test(args)) {
    const lines = ja
      ? [
          "/git-agg-commit [--lang=<lang>] [--help]",
          "",
          "オプション:",
          "  --lang=<lang>  一時的に言語を上書き（保存されません）",
          "  --help         このヘルプを表示",
        ]
      : [
          "/git-agg-commit [--lang=<lang>] [--help]",
          "",
          "Options:",
          "  --lang=<lang>  Temporarily override language (not saved)",
          "  --help         Show this help message",
        ];
    if (ctx.hasUI) {
      ctx.ui.notify(lines.join("\n"), "info");
    }
    return;
  }

  // Parse language argument (temporary override, does not save)
  const langArg = parseLangArg(args);
  let runLang = lang;
  if (langArg) {
    runLang = langArg;
    ctx.ui.notify(`Language set to: ${langArg} (this run only)`, "info");
  }

  if (!ctx.hasUI) {
    return;
  }

  if (isAggCommitRunning) {
    ctx.ui.notify(
      isJapanese(runLang)
        ? "git-agg-commit 実行中です。完了してから再度実行してください。"
        : "git-agg-commit is already running. Please wait for it to complete.",
      "warning",
    );
    return;
  }

  isAggCommitRunning = true;
  const autoCommit = getAutoAggCommit(ctx.cwd);

  // Hide the persistent auto-commit indicator while agg-commit runs
  // to avoid duplicate status display
  if (autoCommit) {
    clearAutoAggCommitStatus(ctx.ui);
  }

  try {
    ctx.ui.setStatus(STATUS_ID, statusText(runLang, "prepare", autoCommit));

    if (!(await isGitRepository(pi, ctx.cwd))) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify("Not a git repository", "warning");
      return;
    }

    if (!(await hasChanges(pi, ctx.cwd))) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify("No changes to commit", "info");
      return;
    }

    // Snapshot changes via stash to freeze the diff
    ctx.ui.setStatus(STATUS_ID, statusText(runLang, "collectDiff", autoCommit));
    const { code: stashCode } = await pi.exec(
      "git",
      ["stash", "push", "-u", "-m", "pi-git-agg-commit"],
      { cwd: ctx.cwd },
    );
    if (stashCode !== 0) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify("Failed to stash changes", "warning");
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

      // stash@{0}^3 contains untracked files when -u was used
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
      ctx.ui.notify("No changes to commit", "info");
      return;
    }

    // Analyze diff into logical hunks
    ctx.ui.setStatus(STATUS_ID, statusText(runLang, "analyze", autoCommit));
    let hunks = await analyzeDiff(pi, ctx, diff);
    if (hunks.length === 0) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify("No hunks found to commit", "info");
      return;
    }

    // Sanitize commit messages
    ctx.ui.setStatus(
      STATUS_ID,
      statusText(runLang, "generateMessage", autoCommit),
    );
    hunks = hunks.map(sanitizeHunk);

    // Deduplicate files across hunks: each file belongs only to its first hunk
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

    // Stage and commit each hunk
    ctx.ui.setStatus(STATUS_ID, statusText(runLang, "commit", autoCommit));
    let committedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const hunk of hunks) {
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
        try {
          await resetStaging(pi, ctx.cwd);
        } catch {
          // Ignore reset errors
        }
        const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
        ctx.ui.notify(
          `Commit failed for "${hunk.message}" (exit code ${exitCode}).${detail} Staging has been reset.`,
          "warning",
        );
        failedCount++;
        continue;
      }

      committedCount++;
    }

    // Notify completion
    if (!autoCommit) {
      ctx.ui.setStatus(STATUS_ID, "");
    }
    const parts: string[] = [];
    if (committedCount > 0)
      parts.push(
        `Created ${committedCount} commit${committedCount > 1 ? "s" : ""}`,
      );
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);

    if (parts.length === 0) {
      ctx.ui.notify("All commits failed", "error");
    } else if (failedCount > 0) {
      ctx.ui.notify(parts.join(", "), "warning");
    } else {
      ctx.ui.notify(parts.join(", "), "info");
    }
  } finally {
    isAggCommitRunning = false;
    if (autoCommit) {
      restoreAutoAggCommitStatus(ctx.ui, ctx.cwd);
    }
  }
}
