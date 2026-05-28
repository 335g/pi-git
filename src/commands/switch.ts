/**
 * /git-switch command
 *
 * Switch between git branches.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAndSwitchBranch,
  getBranches,
  getCurrentBranch,
  isGitRepository,
  switchBranch,
} from "../core/git.js";
import { isJapanese } from "../utils/lang.js";
import { getSettings } from "../utils/settings.js";

export async function handleSwitch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const lang = getSettings(ctx.cwd).lang ?? "en";
  const ja = isJapanese(lang);

  if (!(await isGitRepository(pi, ctx.cwd))) {
    ctx.ui.notify(
      ja ? "Gitリポジトリではありません" : "Not a git repository",
      "warning",
    );
    return;
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // Parse flags
  let createNew = false;
  let listOnly = false;
  let help = false;
  const positional: string[] = [];

  for (const token of tokens) {
    if (token === "-c" || token === "--create") createNew = true;
    else if (token === "--list" || token === "-l") listOnly = true;
    else if (token === "--help" || token === "-h") help = true;
    else positional.push(token);
  }

  if (help) {
    const lines = ja
      ? [
          "/git-switch [<branch>] [-c|--create] [--list] [--help]",
          "",
          "ブランチを切り替えます。",
          "",
          "引数:",
          "  <branch>        切り替えるブランチ名",
          "",
          "フラグ:",
          "  -c, --create    新しいブランチを作成して切り替え",
          "  --list, -l      ブランチ一覧を表示",
          "  --help, -h      このヘルプを表示",
          "",
          "引数を省略すると、ブランチ一覧を表示します。",
        ]
      : [
          "/git-switch [<branch>] [-c|--create] [--list] [--help]",
          "",
          "Switch between git branches.",
          "",
          "Arguments:",
          "  <branch>        Branch name to switch to",
          "",
          "Flags:",
          "  -c, --create    Create a new branch and switch to it",
          "  --list, -l      List all branches",
          "  --help, -h      Show this help message",
          "",
          "Without arguments, lists all branches.",
        ];
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  // List branches if no branch specified or --list flag
  if (listOnly || positional.length === 0) {
    await listBranches(pi, ctx, ja);
    return;
  }

  const branchName = positional[0];

  if (createNew) {
    // Create and switch to new branch
    const result = await createAndSwitchBranch(pi, branchName, ctx.cwd);
    if (result.success) {
      ctx.ui.notify(
        ja
          ? `新しいブランチ '${branchName}' を作成して切り替えました`
          : `Created and switched to new branch '${branchName}'`,
        "info",
      );
    } else {
      ctx.ui.notify(
        ja
          ? `ブランチの作成に失敗しました: ${result.message}`
          : `Failed to create branch: ${result.message}`,
        "error",
      );
    }
  } else {
    // Switch to existing branch
    const result = await switchBranch(pi, branchName, ctx.cwd);
    if (result.success) {
      ctx.ui.notify(
        ja
          ? `ブランチ '${branchName}' に切り替えました`
          : `Switched to branch '${branchName}'`,
        "info",
      );
    } else {
      ctx.ui.notify(
        ja
          ? `ブランチの切り替えに失敗しました: ${result.message}`
          : `Failed to switch branch: ${result.message}`,
        "error",
      );
    }
  }
}

async function listBranches(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  ja: boolean,
): Promise<void> {
  try {
    const currentBranch = await getCurrentBranch(pi, ctx.cwd);
    const branches = await getBranches(pi, ctx.cwd);

    const localBranches = branches.filter((b) => !b.isRemote);
    const remoteBranches = branches.filter((b) => b.isRemote);

    const lines: string[] = [];

    if (ja) {
      lines.push("ローカルブランチ:");
      for (const branch of localBranches) {
        const marker = branch.name === currentBranch ? "* " : "  ";
        lines.push(`${marker}${branch.name}`);
      }

      if (remoteBranches.length > 0) {
        lines.push("");
        lines.push("リモートブランチ:");
        for (const branch of remoteBranches) {
          lines.push(`  ${branch.name}`);
        }
      }
    } else {
      lines.push("Local branches:");
      for (const branch of localBranches) {
        const marker = branch.name === currentBranch ? "* " : "  ";
        lines.push(`${marker}${branch.name}`);
      }

      if (remoteBranches.length > 0) {
        lines.push("");
        lines.push("Remote branches:");
        for (const branch of remoteBranches) {
          lines.push(`  ${branch.name}`);
        }
      }
    }

    ctx.ui.notify(lines.join("\n"), "info");
  } catch (error) {
    ctx.ui.notify(
      ja
        ? `ブランチ一覧の取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`
        : `Failed to list branches: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
