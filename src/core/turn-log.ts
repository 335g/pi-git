/**
 * TurnLog — session-scoped conversation log accumulator.
 *
 * Stores per-turn (user message, assistant excerpt, changed files) in memory.
 * Used by batch-committer to inject conversation context into the AI prompt
 * when splitting diffs into logical hunks.
 */

import type { AgentEndEvent } from "../types.js";
import {
  type SimpleMessage,
  collectMessagesByRole,
  tailTruncate,
  stripConversationalMarkers,
} from "../utils/message-utils.js";

/** One turn's worth of conversation context */
interface TurnEntry {
  /** Turn index (1-based) */
  index: number;
  /** User's message — tail-truncated */
  userMessage: string;
  /** Assistant's first meaningful excerpt */
  assistantExcerpt: string;
  /** Files changed during this turn (REQUIRED for AI correlation) */
  filesChanged: string[];
}

/**
 * Session-scoped conversation log.
 *
 * Use as a module-level singleton (same pattern as footerManager):
 *   import { turnLog } from "./turn-log.js";
 */
export class TurnLog {
  static readonly MAX_ENTRIES = 20;
  static readonly MAX_CHARS = 8_000;

  private entries: TurnEntry[] = [];
  private turnIndex = 0;
  private _warnNotified = false;

  get turnCount(): number {
    return this.entries.length;
  }

  get totalFilesChanged(): number {
    const allFiles = new Set<string>();
    for (const e of this.entries) {
      for (const f of e.filesChanged) allFiles.add(f);
    }
    return allFiles.size;
  }

  get warnNotified(): boolean {
    return this._warnNotified;
  }

  set warnNotified(value: boolean) {
    this._warnNotified = value;
  }

  /**
   * Append a turn's conversation context.
   * Called from handleAutoCommit() on every agent_end, regardless of mode.
   */
  append(event: AgentEndEvent, changedFiles: string[]): void {
    this.turnIndex++;

    const messages = (event.messages ?? []) as SimpleMessage[];

    // User message: extract the last meaningful user message (newest-first)
    const userMessages = collectMessagesByRole(messages, "user");
    const userMsg = userMessages[0] ?? "";

    // Assistant excerpt: extract first assistant response
    const assistantMessages = collectMessagesByRole(messages, "assistant");
    const assistantMsg = assistantMessages[0] ?? "";

    this.entries.push({
      index: this.turnIndex,
      userMessage: tailTruncate(
        stripConversationalMarkers(userMsg),
        500,
      ),
      assistantExcerpt: stripConversationalMarkers(assistantMsg).slice(
        0,
        300,
      ),
      filesChanged: changedFiles.slice(0, 20),
    });

    // Enforce budget: keep most recent entries
    if (this.entries.length > TurnLog.MAX_ENTRIES) {
      this.entries = this.entries.slice(-TurnLog.MAX_ENTRIES);
    }
  }

  /**
   * Serialize for AI prompt injection.
   * Returns "" when empty (caller should omit the section).
   */
  formatForPrompt(): string {
    if (this.entries.length === 0) return "";

    const lines: string[] = [];
    let totalChars = 0;

    // Most recent entries first (recency matters more for AI attention)
    for (const e of [...this.entries].reverse()) {
      const block = [
        `### Turn ${e.index}`,
        `User: ${e.userMessage}`,
        `Assistant: ${e.assistantExcerpt}`,
        e.filesChanged.length
          ? `Files: ${e.filesChanged.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      if (totalChars + block.length > TurnLog.MAX_CHARS) break;
      lines.push(block);
      totalChars += block.length + 1; // +1 for double-newline separator
    }

    return lines.join("\n\n");
  }

  /** Clear all entries (called after successful batch commit) */
  clear(): void {
    this.entries = [];
    this.turnIndex = 0;
    this._warnNotified = false;
  }
}

/** Module-level singleton — same pattern as footerManager */
export const turnLog = new TurnLog();
