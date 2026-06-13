/**
 * pi-git extension entry point
 *
 * Provides slash commands for git operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentEndEvent } from "./types.js";
import { handleAggCommit } from "./commands/agg-commit.js";
import { handleConfig } from "./commands/config.js";
import { handleDiagnostics } from "./commands/diagnostics.js";
import { recoverOrphanedStashes } from "./core/orphan-recovery.js";
import { turnLog } from "./core/turn-log.js";
import { isGitRepository, hasChanges } from "./core/git.js";
import { footerManager } from "./utils/footer-manager.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (ctx.hasUI) {
        turnLog.clear(); // reset from previous session
        footerManager.initialize(pi, ctx.ui, ctx.cwd);
        await recoverOrphanedStashes(pi, ctx);
        await footerManager.refresh();
      }
    } catch {
      // Silently ignore initialization errors to prevent unhandled rejections
    }
  });

  pi.registerCommand("git-agg-commit", {
    description:
      "Auto stage and commit changes with AI-generated Conventional Commits messages",
    handler: async (args, ctx) => {
      try {
        await handleAggCommit(pi, ctx, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) {
          ctx.ui.notify(`[pi-git] /git-agg-commit error: ${msg}`, "error");
        }
      }
    },
  });

  pi.registerCommand("git-config", {
    description: "Get, set, or list pi-git configuration values",
    handler: async (args, ctx) => {
      try {
        await handleConfig(pi, ctx, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) {
          ctx.ui.notify(`[pi-git] /git-config error: ${msg}`, "error");
        }
      }
    },
  });


  pi.registerCommand("git-diagnostics", {
    description: "Show P0 effectiveness measurement counters",
    handler: async (args, ctx) => {
      try {
        await handleDiagnostics(pi, ctx, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) {
          ctx.ui.notify(`[pi-git] /git-diagnostics error: ${msg}`, "error");
        }
      }
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (footerManager.isRunning()) return;

    try {
      const isRepo = await isGitRepository(pi);
      if (!isRepo) return;

      if (!(await hasChanges(pi))) {
        await footerManager.refresh();
        return;
      }

      const { stdout } = await pi.exec("git", ["status", "--short"], {
        cwd: ctx.cwd,
      });

      const changedFiles = stdout
        .split("\n")
        .filter(Boolean)
        .map((line: string) => line.slice(3).trim())
        .filter(Boolean);

      if (changedFiles.length === 0) return;

      turnLog.append(event as AgentEndEvent, changedFiles);
      footerManager.setBatchStatus(
        turnLog.turnCount,
        turnLog.totalFilesChanged,
      );
    } catch {
      // Silently ignore errors
    }
  });
}
