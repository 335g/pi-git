# Implementation Plan: Small Model Commit Message Quality Fix

**Date:** 2026-06-11
**Status:** Draft → Under Review
**Based on:** 3-parallel reviewer reports (prompt-engineering, budget-truncation, refinement-heuristics)

---

## Goal

Make `generateAutoCommitMessage` produce specific, useful Conventional Commit messages even when using small/cheap models (e.g., `gpt-5.4-mini`), not just large models (e.g., `deepseek-v4-pro`).

## Root Cause Summary

The current code relies on large-model capabilities (raw diff parsing, instruction following, no output chatter). Small models need: output cleanup, tighter constraints, better budget allocation, language-aware generic detection, and balanced heuristics.

---

## Phase 1: P0 Fixes (Critical — ~50 lines total)

### P0-1: Add `cleanCommitOutput()` before sanitization

**File:** `src/core/auto-commit-message.ts`
**Where:** New function, called in `generateAutoCommitMessage` before `sanitizeCommitMessage`

**What:**
- Extract from markdown fences (` ```...``` `)
- Strip common chat prefixes (English + Japanese)
- Take first line that matches Conventional Commit pattern
- Fall back to first non-empty line

```typescript
function cleanCommitOutput(raw: string): string {
  let text = raw.trim();

  // Layer 1: Extract from markdown fences
  const fenceMatch = text.match(/```(?:\w*)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Layer 2: Strip common chat prefixes
  const prefixPatterns = [
    /^(?:here\s+is\s+(?:the\s+)?(?:commit\s+)?message[:\s]*)/i,
    /^(?:commit\s+message[:\s]*)/i,
    /^(?:the\s+commit\s+message\s+(?:is|should\s+be)[:\s]*)/i,
    /^(?:提案するコミットメッセージ[:\s]*)/,
    /^(?:コミットメッセージ[:\s]*)/,
    /^(?:以下がコミットメッセージです[:\s]*)/,
    /^(?:sure!?\s*(?:here\s+is\s+)?[:\s]*)/i,
  ];
  for (const pat of prefixPatterns) {
    text = text.replace(pat, "").trim();
  }

  // Layer 3: Find first line matching Conventional Commit
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const ccLine = lines.find(l =>
    /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+?\))?!?:\s/.test(l)
  );
  if (ccLine) return ccLine;

  // Layer 4: Fall back to first non-empty line
  return lines[0] || text;
}
```

### P0-2: Reduce maxTokens from 1024 to 200

**File:** `src/core/auto-commit-message.ts`
**Where:** `generateAutoCommitMessage` → `aiComplete` call

**What:** Add `maxTokens: 200` to the `aiComplete` options. A single-line commit message needs ~30 tokens.

```diff
  const result = await aiComplete(ctx, {
    systemPrompt: getSystemPrompt(lang),
    userMessage: buildPrompt(...),
+   maxTokens: 200,
  });
```

### P0-3: Add Japanese generic message patterns

**File:** `src/core/auto-commit-message.ts`
**Where:** `GENERIC_MESSAGE_PATTERNS` array + `isGenericMessage` function

**What:** Add Japanese patterns that detect generic messages like `fix: 修正しました`, `chore: ファイルを更新`, `feat: 機能を追加`

```typescript
const GENERIC_MESSAGE_PATTERNS: RegExp[] = [
  // English patterns (existing)
  /^chore:\s*apply\s*changes?\s*$/i,
  /^chore:\s*update\s*(files?)?\s*$/i,
  /^chore:\s*commit\s*changes?\s*$/i,
  /^chore:\s*modify\s*(files?)?\s*$/i,
  /^chore:\s*update\s+\S+\s*$/i,
  /^(feat|fix|chore|docs|style|refactor|test):\s*.{0,10}$/i,

  // Japanese patterns
  /^(feat|fix|chore|docs|style|refactor|test):\s*(変更|修正|更新|対応|追加|削除|改善|実装|作成|適用|反映|編集)(\s*(を|しました|しました。|を行いました|を実施|を反映|いたしました))?$/i,
  /^chore:\s*(変更を適用|ファイルを更新|更新しました|修正しました)\s*$/i,
];
```

### P0-4: Rebalance assistant vs diff budget

**File:** `src/core/auto-commit-message.ts`
**Where:** `buildPrompt` function, budget constants

**What:** Increase assistant budget (the most valuable signal for small models), decrease diff budget.

```diff
- const MAX_ASSISTANT_CHARS = 600;
+ const MAX_ASSISTANT_CHARS = 2500;
- const MAX_DIFF_CHARS = 5000;
+ const MAX_DIFF_CHARS = 3000;
```

### P0-5: Fix newest-first budget consumption

**File:** `src/core/auto-commit-message.ts`
**Where:** `buildPrompt` function, user/assistant section loops

**What:** Remove `reverse()` calls. Process `userMessages` and `assistantMessages` newest-first so the most recent (most relevant) messages survive truncation.

```diff
- for (const msg of userMessages.reverse()) {
+ for (const msg of userMessages) {
      if (userBudget <= 0) break;
      const truncated = truncate(msg, userBudget);
      userLines.push(truncated);
      userBudget -= truncated.length;
  }
- const userStr = userLines.reverse().join("\n---\n");
+ const userStr = userLines.join("\n---\n");
```

Same pattern for assistant section.

---

## Phase 2: P1 Fixes (High Impact — ~80 lines total)

### P1-1: Move few-shot examples into system prompt

**Files:** `src/i18n/messages.ts`, `src/core/auto-commit-message.ts`

**What:** Embed examples directly in `autoCommitMsg.systemPrompt` for both `en` and `ja`. Remove or simplify `{examples}` from `buildPrompt` template.

**English system prompt (new):**
```
You are a commit message generator. From the following information, understand what changes were made and generate a single Conventional Commit message.

The GIT DIFF is the most reliable source of what actually changed. Use it as the primary driver for the commit message. The user's request provides intent, and the assistant's response and changed files list are supplementary.

Rules:
- Choose type from: feat, fix, docs, style, refactor, test, chore
- Write the subject in English
- Keep subject under 50 characters
- Use imperative mood
- Include scope only if clearly inferable from the diff

Examples:
User: "Add a login form to the auth page" | Files: src/auth/login.tsx, src/auth/api.ts
→ feat(auth): add login form

User: "Fix the null pointer error in the payment flow" | Files: src/payment/processor.ts
→ fix(payment): add null check in processor

Return ONLY the commit message string. No explanations or code fences.
```

**Japanese system prompt (new):** Same structure with Japanese examples.

### P1-2: Balance `specificityScore` weights for Japanese

**File:** `src/core/auto-commit-message.ts`
**Where:** `specificityScore` function

**What:** Increase Japanese scoring weights to parity with English:

```diff
  if (lang === "ja") {
    const kanjiCount = (m.match(/[\u4e00-\u9faf]/g) || []).length;
-   score += Math.min(kanjiCount, 10) * 0.5;
+   score += Math.min(kanjiCount, 15) * 1.0;

    const katakanaTerms = m.match(/[\u30a0-\u30ff]{2,}/g) || [];
-   score += katakanaTerms.length * 2;
+   score += katakanaTerms.length * 3;

+   // Reward Japanese concrete verbs (parallel to English concreteVerbs)
+   const japaneseConcreteVerbs = /(追加|実装|作成|削除|修正|改善|整理|統合|分割|移行|更新|導入|廃止|対応|設定|構成|接続)/g;
+   score += (m.match(japaneseConcreteVerbs) || []).length * 2;

+   // Penalize Japanese generic filler
+   const japaneseGenericWords = /(変更|修正|更新|対応|適用|反映)(?!\S)/g;
+   const jpGenericCount = (m.match(japaneseGenericWords) || []).length;
+   score -= jpGenericCount * 2;

-   if (/^(変更|修正|更新|対応|追加|削除|改善|実装|作成)$/.test(m.trim())) {
+   if (/^(変更|修正|更新|対応|追加|削除|改善|実装|作成|適用|反映)$/.test(m.trim())) {
      score -= 4;
    }
  }
```

### P1-3: Skip AI comparison for known-weak models

**File:** `src/core/auto-commit-message.ts`
**Where:** `refineMessageIfGeneric` function

**What:** After heuristic quick-guard fails, check if the current model is known-weak. If so, skip the AI comparison call and use the higher heuristic score.

```typescript
// Known small/cheap model patterns
const CHEAP_MODEL_PATTERNS = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];

function isCheapModel(modelId: string): boolean {
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId));
}
```

Then in `refineMessageIfGeneric`:
```typescript
// After heuristic quick-guard:
if (isCheapModel(ctx.model?.id ?? "")) {
  return userScore > genScore ? userCandidate : generatedMessage;
}
```

### P1-4: Robust vote parsing with last-wins tiebreaker

**File:** `src/core/auto-commit-message.ts`
**Where:** `refineMessageIfGeneric` function, vote parsing section

**What:** When the model outputs both "A" and "B", pick the one that appears last (common in "Both A and B are good, but B is better" patterns).

```diff
  const voteA = /\bA\b/i.test(text) && !/\bB\b/i.test(text);
  const voteB = /\bB\b/i.test(text) && !/\bA\b/i.test(text);
  if (voteA) return generatedMessage;
  if (voteB) return userCandidate;

+ // Both appear — pick the one mentioned last ("Both are good, but B wins")
+ const aPos = text.search(/\bA\b/i);
+ const bPos = text.search(/\bB\b/i);
+ if (aPos >= 0 && bPos >= 0) {
+   return bPos > aPos ? userCandidate : generatedMessage;
+ }
```

---

## Phase 3: P2 Follow-ups (Lower Priority)

### P2-1: Newline-boundary diff truncation
Align auto-commit-message's diff truncation with diff-analyzer's approach (cut at line boundaries, not space boundaries).

### P2-2: English conversational markers in `isValidCommitSubject`
Add English guard patterns (e.g., `can you`, `could you`, `I'd like`).

### P2-3: Unit tests
Add tests for `isGenericMessage`, `sanitizeCommitMessage`, `specificityScore`, `userMessageToCandidate`, `isValidCommitSubject`.

---

## Files Changed

| File | Phase | Changes |
|------|-------|---------|
| `src/core/auto-commit-message.ts` | P0+P1 | ~100 lines added/modified |
| `src/i18n/messages.ts` | P1 | ~20 lines (system prompt rewrite for en + ja) |
| `src/core/commit-message.ts` | (no changes — cleanup in auto-commit-message.ts) | 0 |

## Risks

| Risk | Mitigation |
|------|-----------|
| Budget rebalance reduces diff context for very large models | P2-1: model-aware budgets; for now, diff still gets 3000 chars (plenty) |
| Japanese generic patterns may false-positive on specific messages | Patterns use exact match on short Japanese generic phrases; false positive risk is low |
| `cleanCommitOutput` may strip valid content | Layer 3 (find CC line) is the primary extractor; prefix patterns are conservative |
| Removing `reverse()` changes display order | The join produces newest-first which is actually more useful (most recent context first) |

## Validation

After implementation, test with:
1. **English + deepseek-v4-pro**: Should produce same or better messages (no regression)
2. **English + gpt-5.4-mini**: Should produce specific messages instead of "chore: apply changes"
3. **Japanese + deepseek-v4-pro**: Should produce same or better (no regression)
4. **Japanese + gpt-5.4-mini**: Should produce specific Japanese messages; generic ones caught and refined
5. **Chatty output simulation**: Add "Here is the commit message:" prefix to AI output, verify `cleanCommitOutput` strips it
