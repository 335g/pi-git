/**
 * /git-auto-agg-commit command
 *
 * Toggle auto-agg-commit feature: automatically run git-agg-commit
 * after the assistant finishes responding when there are changes.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "../utils/lang.js";
import {
  getAutoAggCommit,
  getLanguage,
  getLocalSettingsPath,
  saveGlobalSettings,
  saveLocalSettings,
} from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";

const P = "[pi-git]";

export async function handleAutoAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const trimmed = args.trim().toLowerCase();
  const current = getAutoAggCommit();
  const lang = getLanguage(ctx.cwd);

  if (trimmed === "--help") {
    ctx.ui.notify(
      t(lang,
        [
          "/git-auto-agg-commit [on|off|toggle] [--help]",
          "",
          "サブコマンド:",
          "  on      自動 git-agg-commit を有効にする",
          "  off     自動 git-agg-commit を無効にする",
          "  toggle  自動 git-agg-commit の有効/無効を切り替える",
          "",
          "フラグ:",
          "  --help  このヘルプを表示",
          "",
          "引数を省略すると、現在の状態を表示します。",
        ].join("\n"),
        [
          "/git-auto-agg-commit [on|off|toggle] [--help]",
          "",
          "Subcommands:",
          "  on      Enable auto git-agg-commit",
          "  off     Disable auto git-agg-commit",
          "  toggle  Toggle auto git-agg-commit",
          "",
          "Flags:",
          "  --help  Show this help message",
          "",
          "When called without arguments, shows the current status.",
        ].join("\n"),
      ),
      "info",
    );
    return;
  }

  let next: boolean;
  switch (trimmed) {
    case "on":
      next = true;
      break;
    case "off":
      next = false;
      break;
    case "toggle":
      next = !current;
      break;
    case "":
      ctx.ui.notify(
        t(lang,
          `${P} 自動 git-agg-commit は${current ? "有効" : "無効"}です`,
          `${P} Auto git-agg-commit is ${current ? "enabled" : "disabled"}`,
        ),
        "info",
      );
      return;
    default:
      ctx.ui.notify(
        t(lang,
          `${P} 引数が不正です。on, off, toggle のいずれかを指定してください`,
          `${P} Invalid argument. Use "on", "off", or "toggle"`,
        ),
        "warning",
      );
      return;
  }

  const localPath = getLocalSettingsPath(ctx.cwd);
  if (localPath) {
    saveLocalSettings({ auto_agg_commit: next }, ctx.cwd);
  } else {
    saveGlobalSettings({ auto_agg_commit: next });
  }

  await footerManager.refresh();

  const enabledJa = next ? "有効" : "無効";
  const enabledEn = next ? "enabled" : "disabled";
  if (localPath) {
    ctx.ui.notify(
      t(lang,
        `${P} 自動 git-agg-commit を${enabledJa}にしました（ローカル設定）`,
        `${P} Auto git-agg-commit ${enabledEn} (local config)`,
      ),
      "info",
    );
  } else {
    ctx.ui.notify(
      t(lang,
        `${P} 自動 git-agg-commit を${enabledJa}にしました（グローバル設定 — Gitリポジトリ外のため）`,
        `${P} Auto git-agg-commit ${enabledEn} (global config — outside git repo)`,
      ),
      "info",
    );
  }
}
