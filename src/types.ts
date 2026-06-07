/**
 * Types for pi-git extension
 */

export interface Hunk {
  /** Files included in this hunk */
  files: string[];
  /** Conventional Commit message for this hunk */
  message: string;
}

export interface AgentEndEvent {
  messages?: Array<{
    role: string;
    content: unknown;
  }>;
}
