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
import { handleAutoCommit } from "./core/auto-commit.js";
import { footerManager } from "./utils/footer-manager.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      footerManager.initialize(pi, ctx.ui, ctx.cwd);
      await footerManager.refresh();
    }
  });

  pi.registerCommand("git-agg-commit", {
    description:
      "Auto stage and commit changes with AI-generated Conventional Commits messages",
    handler: async (args, ctx) => {
      await handleAggCommit(pi, ctx, args);
    },
  });

  pi.registerCommand("git-config", {
    description: "Get, set, or list pi-git configuration values",
    handler: async (args, ctx) => {
      await handleConfig(pi, ctx, args);
    },
  });

  pi.registerCommand("git-auto-agg-commit", {
    description: "Toggle automatic git-agg-commit after assistant responses",
    handler: async (args, ctx) => {
      await handleAutoAggCommit(pi, ctx, args);
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    await handleAutoCommit(pi, ctx, event as AgentEndEvent);
  });
}
