# Context Budget & Truncation Review — Commit Message Generation

**Date:** 2026-06-11
**Files reviewed:**
- `src/core/auto-commit-message.ts` (primary)
- `src/core/diff-analyzer.ts` (comparison)
- `src/core/ai.ts` (AI defaults)
- `src/i18n/messages.ts` (prompt templates)
- `src/core/resolve-model.ts` (model resolution)

---

## Summary

The commit message generation pipeline has **severe budget misallocation** that disproportionately harms small models (`gpt-5.4-mini`) while leaving large models (`deepseek-v4-pro`) largely unaffected. There are **6 concrete issues**, of which 2 are critical blockers for small-model quality, 2 are high-severity, and 2 are medium. All budgets are hardcoded with zero model awareness.

---

## Issue 1 — [CRITICAL] Budget consumed oldest-first, newest messages dropped first

**File:** `src/core/auto-commit-message.ts`
**Lines:** 317-325 (user), 332-339 (assistant)

### Evidence

```typescript
// collectMessagesByRole returns newest-first (line 285-296):
for (let i = messages.length - 1; i >= 0; i--) { ... result.push(text); }

// buildPrompt reverses to oldest-first, then consumes budget:
for (const msg of userMessages.reverse()) {  // reversed = oldest first
    if (userBudget <= 0) break;
    const truncated = truncate(msg, userBudget);
    userLines.push(truncated);
    userBudget -= truncated.length;
}
```

### Problem

Messages are collected newest-first from `collectMessagesByRole`, then `reverse()`d to oldest-first before budget consumption. This means:

1. The **oldest** message gets the full budget.
2. Budget is exhausted on old messages.
3. The **newest** (most recent, most contextually relevant) messages get **zero budget** when the limit is hit.

For a session with many turns, the most recent assistant response that describes *what was just done* may be entirely dropped, while a stale "initial setup" message from 10 turns ago is preserved.

### Impact on small models

Small models rely more heavily on recent context because they have weaker long-range reasoning. Dropping the most recent assistant summary is catastrophic for `gpt-5.4-mini` but largely invisible to `deepseek-v4-pro`, which can infer intent from the raw diff alone.

### Suggested fix

```diff
  const userLines: string[] = [];
  let userBudget = MAX_USER_CHARS;
- for (const msg of userMessages.reverse()) {
+ // Process newest-first so the most recent messages survive truncation
+ for (const msg of userMessages) {
      if (userBudget <= 0) break;
      const truncated = truncate(msg, userBudget);
      userLines.push(truncated);
      userBudget -= truncated.length;
  }
- const userStr = userLines.reverse().join("\n---\n");
+ // userLines is now newest-first (desired display order)
+ const userStr = userLines.join("\n---\n");
```

Same fix for assistant section (line 332-339). The `reverse()` at both the iteration and the join should be removed so the newest messages get budget priority and display newest-first.

---

## Issue 2 — [CRITICAL] Assistant section severely under-budgeted relative to diff

**File:** `src/core/auto-commit-message.ts`
**Lines:** 306-309

```typescript
const MAX_USER_CHARS = 1500;
const MAX_ASSISTANT_CHARS = 600;
const MAX_FILES_CHARS = 500;
const MAX_DIFF_CHARS = 5000;
```

### Problem

| Section | Budget (chars) | Small-model value |
|---------|---------------|-------------------|
| User request | 1500 | Medium (conversational, needs interpretation) |
| **Assistant response** | **600** | **Extremely high** (already-analyzed, structured) |
| Changed files | 500 | Low |
| Diff | 5000 | Low for small models (raw diff is hard to parse) |

The assistant's response is a **pre-digested summary** of what was done. It's already in natural language, filtered for relevance, and written by an AI that had full context. For small models that struggle with raw git diffs, the assistant summary is the **single most valuable piece of context**.

Yet it gets only **600 characters** — less than a typical tweet. A single assistant turn can easily be 1500–3000 characters. At 600 chars, the model sees at best the opening sentence of one assistant response.

Meanwhile, the raw diff gets **5000 characters** — 8.3× more budget. For `gpt-5.4-mini`, that raw diff is largely noise, while for `deepseek-v4-pro` it's perfectly parseable.

### Impact on small models

This is the **primary cause** of the `gpt-5.4-mini` vs `deepseek-v4-pro` quality gap. `deepseek-v4-pro` can extract meaning from 5000 chars of raw diff and doesn't need the assistant summary. `gpt-5.4-mini` can't parse raw diffs well and desperately needs the assistant summary — which is starved at 600 chars.

### Suggested fix

**Option A — Rebalance (minimum fix):**
```diff
- const MAX_ASSISTANT_CHARS = 600;
+ const MAX_ASSISTANT_CHARS = 2500;
- const MAX_DIFF_CHARS = 5000;
+ const MAX_DIFF_CHARS = 3000;
```

**Option B — Model-aware allocation (preferred):** Detect model capability and adjust. For small/cheap models, prioritize the assistant summary. For large models, keep the diff-heavy allocation. See Issue 5.

---

## Issue 3 — [HIGH] `truncate()` has no semantic awareness

**File:** `src/core/auto-commit-message.ts`
**Lines:** 31-37

```typescript
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.substring(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.7) return slice.substring(0, lastSpace) + "...";
  return slice + "...";
}
```

### Problem

1. **No semantic boundary awareness.** The function cuts at spaces only — it has no concept of sentence boundaries (`. `, `。`), paragraph breaks (`\n\n`), or structural markers. A cut mid-sentence is barely better than a cut mid-word.

2. **The `0.7` threshold is arbitrary.** If the last space is at 69% of maxChars, the cut is at a hard character boundary (possibly mid-word). Why 70%? There's no justification.

3. **No priority ordering of sections within a message.** An assistant response may start with pleasantries ("Sure! Here's what I did:") and end with the actual changes. The truncation always takes the beginning — losing the valuable tail.

4. **`"..."` suffix bleeds budget.** The 3-char `"..."` is appended *after* truncation but not subtracted from the budget tracking (`userBudget -= truncated.length`). This causes slight budget overshoot and the visual noise of `"..."` adds no value for the AI.

### Impact

For small models, every character of the assistant summary matters. Arbitrary mid-sentence truncation destroys coherence at the point where the model needs it most.

### Suggested fix

```typescript
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.substring(0, maxChars);
  // Prefer sentence boundaries: . ! ? 。 followed by space/newline
  const sentenceBreak = slice.match(/.*[.!?。](?=\s|$)/g);
  if (sentenceBreak) {
    const last = sentenceBreak[sentenceBreak.length - 1];
    if (last.length > maxChars * 0.5) return last;
  }
  // Fall back to paragraph/newline boundaries
  const lastPara = slice.lastIndexOf("\n\n");
  if (lastPara > maxChars * 0.5) return slice.substring(0, lastPara);
  // Fall back to line boundaries
  const lastLine = slice.lastIndexOf("\n");
  if (lastLine > maxChars * 0.5) return slice.substring(0, lastLine);
  // Last resort: space boundary
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.3) return slice.substring(0, lastSpace);
  return slice;
}
```

Remove the `"..."` suffix — it wastes tokens and doesn't help the AI.

---

## Issue 4 — [HIGH] Diff truncation wastes budget on small-model-unparseable content

**File:** `src/core/auto-commit-message.ts`, line 349-352
**Comparison:** `src/core/diff-analyzer.ts`, contrast in approach

### What auto-commit-message does:
```typescript
// auto-commit-message.ts: 5000 chars, single shot, strip noise first
const cleaned = stripDiffNoise(diff);
diffSection = truncate(cleaned, MAX_DIFF_CHARS);
```

### What diff-analyzer does:
```typescript
// diff-analyzer.ts: 30000 bytes, batched by file, groups related files
const MAX_DIFF_BYTES = 30_000;
const FILES_PER_BATCH = 8;

// Batches avoid unrelated file noise; per-batch truncation preserves
// file-level coherence
const batches = splitDiffIntoBatches(diff, FILES_PER_BATCH);
```

### Problem

| Aspect | auto-commit-message | diff-analyzer |
|--------|-------------------|---------------|
| Max size | 5,000 chars | 30,000 bytes (~30K chars) |
| Batching | None (single shot) | Per-file batch (8 files/batch) |
| Coherence | Raw truncation at char boundary | Truncation at newline boundary |
| Grouping | No file grouping | Directory-based grouping |

diff-analyzer's approach is superior because:
1. **Newline truncation** preserves line-level diff syntax (a diff cut mid-line is unparseable).
2. **Batching** prevents unrelated files from polluting each other's context.
3. **30K budget** is 6× larger than auto-commit-message's 5K.

auto-commit-message's `stripDiffNoise` then `truncate` at a space boundary is a poor fit for diff content — diffs don't have "words" in the natural language sense. A space-boundary cut could break `@@ -1,5 +1,7 @@` or a `+   const x` line in the middle, rendering it syntactically invalid.

### Impact

For `gpt-5.4-mini`, the already-hard-to-parse diff is further mangled by space-boundary truncation. For `deepseek-v4-pro`, the model is robust enough to handle it — another reason the gap exists.

### Suggested fix

Align auto-commit-message's diff handling with diff-analyzer's approach:

```typescript
// In auto-commit-message.ts, import or replicate diff-analyzer's truncateDiff:
function truncateDiffAtNewline(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  const slice = diff.substring(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.substring(0, lastNewline) : slice;
}

// Use it:
const cleaned = stripDiffNoise(diff);
diffSection = truncateDiffAtNewline(cleaned, MAX_DIFF_CHARS);
```

---

## Issue 5 — [MEDIUM] Zero model-awareness in budget allocation

**Files:**
- `src/core/auto-commit-message.ts` — all budget constants are hardcoded
- `src/core/resolve-model.ts` — model resolution exists but no capability metadata is extracted
- `src/core/ai.ts` — `maxTokens` defaults to 1024 regardless of model

### Evidence

```typescript
// ai.ts line 56: maxTokens always defaults to 1024
maxTokens: options.maxTokens ?? 1024,

// auto-commit-message.ts: no model parameter, no budget adaptation
export async function generateAutoCommitMessage(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: SimpleMessage[],
  changedFiles: string[],
  diff: string,
): Promise<string> { ... }

// resolve-model.ts: only resolves the model object, doesn't extract
// contextWindow, maxInputTokens, or any capability metadata
```

### Problem

The entire pipeline treats all models identically. But:

| Model | Context window | Diff parsing | Optimal budget split (user/assistant/diff) |
|-------|---------------|-------------|-------------------------------------------|
| `gpt-5.4-mini` | ~8K–16K tokens | Poor | 1500 / **2500** / **2000** |
| `deepseek-v4-pro` | ~128K+ tokens | Excellent | 1500 / 1000 / **5000** |

For a small model with an 8K context window, the current allocation of ~8850 chars (~2200 tokens for the prompt body alone, plus system prompt, plus examples, plus completion tokens) may already be pushing the limit, leaving minimal room for the model to "think." For a large model with 128K, the entire budget could be 10× larger with no risk.

### Suggested fix

**Short-term:** Derive a budget multiplier from the model ID. Even a simple heuristic based on known model families would help:

```typescript
function getBudgetMultiplier(modelId: string): number {
  // Known small models: 1.0x (status quo)
  if (/mini|flash|nano|lite|small|haiku/i.test(modelId)) return 1.0;
  // Mid-size models
  if (/sonnet|gpt-4o/i.test(modelId)) return 2.0;
  // Large models
  return 4.0;  // opus, deepseek, claude-3.5, gpt-4, etc.
}
```

**Long-term:** If `@earendil-works/pi-ai` exposes `model.contextWindow` or `model.maxInputTokens`, use that to compute budgets as a fraction of the available window. Reserve ~25% of the window for the prompt, leaving room for the response and reasoning.

---

## Issue 6 — [MEDIUM] `collectMessagesByRole` collects all messages, then most are discarded

**File:** `src/core/auto-commit-message.ts`
**Lines:** 283-296 (collectMessagesByRole), 315-316 (collect all)

```typescript
const userMessages = collectMessagesByRole(messages, "user");
const assistantMessages = collectMessagesByRole(messages, "assistant");
```

### Problem

`collectMessagesByRole` iterates over **every** message in the conversation (which could be dozens of turns) and extracts text from all of them, only to have `buildPrompt` discard the vast majority due to budget constraints.

While the performance cost is negligible (string iteration is cheap), the design obscures the fact that we don't actually need all messages. We only need the ones that will survive truncation — which is roughly the **last N messages** (newest).

### Suggestion

Consider collecting only the last K messages of each role, where K is derived from the budget:

```typescript
function collectRecentMessagesByRole(
  messages: SimpleMessage[],
  role: string,
  maxCount: number,
): string[] {
  const result: string[] = [];
  for (let i = messages.length - 1; i >= 0 && result.length < maxCount; i--) {
    if (messages[i].role === role) {
      const text = extractTextContent(messages[i].content);
      if (text.trim()) result.push(text);
    }
  }
  return result; // newest first
}
```

This is not a blocker since the current code is functionally correct (truncation handles it), but the clarity improves and it makes the "newest messages are most important" design intent explicit.

---

## Cross-cutting: Why `deepseek-v4-pro` succeeds and `gpt-5.4-mini` fails

The quality gap is explained by the **interaction of Issues 1, 2, and 4**:

| Factor | `deepseek-v4-pro` | `gpt-5.4-mini` |
|--------|-------------------|----------------|
| **Issue 1** (newest dropped) | Fine — can infer intent from diff | Crippled — needs recent assistant context |
| **Issue 2** (assistant starved) | Fine — parses raw diff instead | Crippled — assistant summary is primary signal |
| **Issue 4** (diff mangled) | Fine — robust to broken diff syntax | Crippled — already struggles with valid diffs |

`deepseek-v4-pro` essentially bypasses every budget flaw because it can compensate with raw diff analysis. `gpt-5.4-mini` hits every flaw head-on because it relies on exactly the signals that are starved (assistant summary) or mangled (space-truncated diff).

**The single highest-impact fix is Issue 2 (rebalancing assistant vs diff budget).** Second is Issue 1 (newest-first budget consumption).

---

## Fix priority matrix

| Priority | Issue | Estimated effort | Impact on small models |
|----------|-------|-----------------|----------------------|
| **1** | Issue 2 — Rebalance assistant/diff budget | 2 lines changed | High |
| **2** | Issue 1 — Fix newest-first budget consumption | 4 lines changed | High |
| **3** | Issue 4 — Newline-boundary diff truncation | 5 lines changed, or reuse from diff-analyzer | Medium |
| **4** | Issue 3 — Semantic truncation boundaries | ~20 lines changed | Medium |
| **5** | Issue 5 — Model-aware budget scaling | ~30 lines + heuristic table | Medium–High |
| **6** | Issue 6 — Collect recent messages only | ~15 lines | Low (code quality) |

Issues 1 and 2 together are ~6 lines changed and address the root cause of the `gpt-5.4-mini` failure. They should be the immediate next step.
