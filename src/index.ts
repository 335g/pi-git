/**
 * pi-git extension entry point
 *
 * Provides slash commands for git operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentEndEvent } from "./types.js";
import { handleAggCommit } from "./commands/agg-commit.js";
import { handleAutoAggCommit } from "./commands/auto-agg-commit.js";
import { handleConfig } from "./commands/config.js";
import { handleDiagnostics } from "./commands/diagnostics.js";
import { handleAutoCommit } from "./core/auto-commit.js";
import { recoverOrphanedStashes } from "./core/orphan-recovery.js";
import { footerManager } from "./utils/footer-manager.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (ctx.hasUI) {
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

  pi.registerCommand("git-auto-agg-commit", {
    description: "Toggle automatic git-agg-commit after assistant responses",
    handler: async (args, ctx) => {
      try {
        await handleAutoAggCommit(pi, ctx, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[pi-git] /git-auto-agg-commit error: ${msg}`,
            "error",
          );
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
          ctx.ui.notify(
            `[pi-git] /git-diagnostics error: ${msg}`,
            "error",
          );
        }
      }
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      await handleAutoCommit(pi, ctx, event as AgentEndEvent);
    } catch {
      // Silently ignore auto-commit errors to prevent unhandled rejections
    }
  });
}
