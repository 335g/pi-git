/**
 * Shared message utilities for pi-git.
 *
 * Extracted from auto-commit-message.ts to be usable by TurnLog and other modules.
 */

/** Simple message interface (user/assistant messages from agent events) */
export interface SimpleMessage {
  role: string;
  content: string | unknown;
}

/**
 * Collect all text content from messages of a given role, newest first.
 */
export function collectMessagesByRole(
  messages: SimpleMessage[],
  role: string,
): string[] {
  const result: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === role) {
      const text = extractTextContent(messages[i]!.content);
      if (text.trim()) {
        result.push(text);
      }
    }
  }
  return result;
}

/**
 * Extract text content from message content (handles string, array, or unknown).
 */
export function extractTextContent(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text?: string } =>
          typeof c === "object" && c !== null,
      )
      .map((c) => c.text || "")
      .join("\n");
  }
  return "";
}

/**
 * Head-truncate text to maxChars, keeping whole words at boundaries.
 */
export function headTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.substring(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.7) return slice.substring(0, lastSpace) + "...";
  return slice + "...";
}

/**
 * Tail-truncate text to maxChars (surrogate-pair safe).
 * Keeps the LAST maxChars characters — appropriate when the most relevant
 * content (e.g., user instruction) is at the end of the message.
 */
export function tailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return "..." + chars.slice(-maxChars).join("");
}

/**
 * Strip conversational markers from text.
 * Uses the same removal patterns as userMessageToCandidate() in auto-commit-message.ts.
 */
export function stripConversationalMarkers(
  text: string,
  lang?: string,
): string {
  let result = text
    .replace(/[。.！!？?]$/, "")
    .replace(/\bplease\b/gi, "")
    .replace(/「|」/g, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (lang === "ja" || !lang) {
    result = result
      .replace(/お願いします$/, "")
      .replace(/してください$/, "")
      .replace(/してほしい$/, "")
      .replace(/してもらえますか$/, "")
      .replace(/してくれますか$/, "")
      .replace(/して$/, "");
  }

  return result;
}
