/**
 * Conventional Commits message validation and sanitization
 *
 * Since diff-analyzer.ts already generates Conventional Commits messages via AI,
 * this module focuses on post-processing: validation, cleanup, and fallback.
 */

import { diagIncr } from "../utils/diagnostics.js";
import { t } from "../utils/lang.js";
import type { Hunk } from "../types.js";

/** Generic commit message patterns — messages matching these lack specificity */
export const GENERIC_MESSAGE_PATTERNS: RegExp[] = [
  // English patterns
  /^chore:\s*apply\s*changes?\s*$/i,
  /^chore:\s*update\s*(files?)?\s*$/i,
  /^chore:\s*commit\s*changes?\s*$/i,
  /^chore:\s*modify\s*(files?)?\s*$/i,
  /^chore:\s*update\s+\S+\s*$/i,
  /^(feat|fix|chore|docs|style|refactor|test):\s*[a-zA-Z0-9\s]{0,10}$/i,
  // Japanese patterns
  /^(feat|fix|chore|docs|style|refactor|test):\s*(変更|修正|更新|対応|追加|削除|改善|実装|作成|適用|反映|編集)(\s*を\s*[\u3040-\u30ff\u4e00-\u9faf]{1,8})?(\s*(しました|しました。|を行いました|を実施|を反映|いたしました|します))?\s*$/i,
  /^chore:\s*(変更を適用(?:しました)?|ファイルを更新(?:しました)?|更新しました|修正しました)\s*$/i,
];

/** Heuristic: is this commit message too generic to be useful? */
export function isGenericMessage(message: string): boolean {
  const m = message.trim();
  if (m.length < 12) return true;
  return GENERIC_MESSAGE_PATTERNS.some((p) => p.test(m));
}

/** Valid Conventional Commits types */
const VALID_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "test",
  "chore",
  "perf",
  "ci",
  "build",
  "revert",
];

/** Pattern: type(scope)!: subject or type!: subject */
const CONVENTIONAL_COMMIT_PATTERN = /^(\w+)(\([^)]+\))?(!)?:\s*(.+)$/;

const MAX_SUBJECT_LENGTH = 50;

/**
 * Check if a message follows Conventional Commits format.
 */
export function isConventionalCommit(message: string): boolean {
  const match = CONVENTIONAL_COMMIT_PATTERN.exec(message);
  if (!match) return false;
  const type = match[1];
  return VALID_TYPES.includes(type);
}

/**
 * Build a conventional commit message with a valid type.
 */
function buildMessage(
  type: string,
  scope: string | undefined,
  subject: string,
  breaking = false,
): string {
  const scopePart = scope ? `(${scope})` : "";
  const breakingPart = breaking ? "!" : "";
  return `${type}${scopePart}${breakingPart}: ${subject}`;
}

/**
 * Infer commit type from file paths and content.
 */
export function inferTypeFromFiles(files: string[]): string {
  const allPaths = files.join(" ").toLowerCase();

  if (/\btest\b|spec|\.test\.|\.spec\./.test(allPaths)) return "test";
  if (/readme|\.md$|docs?\//.test(allPaths)) return "docs";
  if (/\.css$|\.scss$|\.less$|\.svg$|\.png$|\.jpg$/.test(allPaths))
    return "style";
  if (
    /package\.json|package-lock|yarn\.lock|pnpm-lock|cargo\.lock|\.lock$|makefile|dockerfile|\.yml$|\.yaml$|\.toml$/.test(
      allPaths,
    )
  ) {
    return "chore";
  }
  if (/\.github|\.ci|\.ci\//.test(allPaths)) return "ci";
  if (/\.config\.|config\/|\.env|\.rc/.test(allPaths)) return "chore";

  return "chore";
}

/**
 * Sanitize and validate a commit message.
 * Returns a clean, valid Conventional Commits message.
 */
export function sanitizeCommitMessage(
  message: string,
  files?: string[],
): string {
  diagIncr("msgSanitized");

  // Defense-in-depth: take only the first non-empty line.
  // Multi-line input should have been cleaned by callers (cleanCommitOutput,
  // parseHunks), but this guards against future callers that forget.
  const firstLine = message
    .split("\n")
    .find((l) => l.trim().length > 0)
    ?.trim();
  let sanitized = (firstLine ?? message).trim();

  // Remove trailing period from subject
  sanitized = sanitized.replace(/\.$/, "");

  // Check if already valid
  if (isConventionalCommit(sanitized)) {
    const match = CONVENTIONAL_COMMIT_PATTERN.exec(sanitized);
    if (!match) {
      // Should not happen since isConventionalCommit passed
      return sanitized;
    }
    let type = match[1];
    const scope = match[2]?.slice(1, -1); // remove parentheses
    let subject = match[4];

    // Normalize type
    if (!VALID_TYPES.includes(type)) {
      type = "chore";
    }

    // Truncate subject if too long
    if (subject.length > MAX_SUBJECT_LENGTH) {
      subject = `${subject.slice(0, MAX_SUBJECT_LENGTH - 3)}...`;
    }

    return buildMessage(type, scope, subject, match[3] === "!");
  }

  // Not a conventional commit - try to fix or fallback
  // If it has a colon, maybe it's an unknown format
  diagIncr("msgSanitizeChanged");
  const colonIndex = sanitized.indexOf(":");
  if (colonIndex > 0) {
    const possibleSubject = sanitized.slice(colonIndex + 1).trim();
    if (possibleSubject.length > 0) {
      const type = files ? inferTypeFromFiles(files) : "chore";
      return buildMessage(type, undefined, possibleSubject);
    }
  }

  // Fallback: treat entire message as subject
  const fallbackType = files ? inferTypeFromFiles(files) : "chore";
  const subject =
    sanitized.length > MAX_SUBJECT_LENGTH
      ? `${sanitized.slice(0, MAX_SUBJECT_LENGTH - 3)}...`
      : sanitized;
  return buildMessage(fallbackType, undefined, subject || "update files");
}

/**
 * Generate a fallback message when AI generation fails entirely.
 */
export function generateFallbackMessage(
  files: string[],
  lang = "en",
): string {
  const type = inferTypeFromFiles(files);
  if (files.length === 1) {
    const fileName = files[0].split("/").pop() || files[0];
    return t(lang, "fallbackCommitMessage.singleFile", {
      type,
      file: fileName,
    });
  }
  return t(lang, "fallbackCommitMessage.multipleFiles", {
    type,
    count: String(files.length),
  });
}

/**
 * Sanitize a hunk's message in place.
 */
export function sanitizeHunk(hunk: Hunk): Hunk {
  return {
    ...hunk,
    message: sanitizeCommitMessage(hunk.message, hunk.files),
  };
}
