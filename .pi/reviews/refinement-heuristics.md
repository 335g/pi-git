# Post-processing, Refinement & Heuristic Logic Review

**Date:** 2026-06-11
**Files reviewed:** `src/core/auto-commit-message.ts`, `src/core/commit-message.ts`, `src/i18n/messages.ts`

---

## Issue 1: Generic message detection is English-only — Japanese generic messages pass undetected

**Severity:** 🔴 CRITICAL
**File:** `src/core/auto-commit-message.ts`, lines 41–48
**Also:** `src/i18n/messages.ts`, lines 125–134 (Japanese system prompt)

### Root cause

The `GENERIC_MESSAGE_PATTERNS` array contains only English regex patterns:

```typescript
// auto-commit-message.ts:41-48
const GENERIC_MESSAGE_PATTERNS: RegExp[] = [
  /^chore:\s*apply\s*changes?\s*$/i,
  /^chore:\s*update\s*(files?)?\s*$/i,
  /^chore:\s*commit\s*changes?\s*$/i,
  /^chore:\s*modify\s*(files?)?\s*$/i,
  /^chore:\s*update\s+\S+\s*$/i,
  /^(feat|fix|chore|docs|style|refactor|test):\s*.{0,10}$/i,  // body ≤10 chars
];
```

Meanwhile, the **Japanese system prompt** explicitly instructs the model to write Japanese:

```
"autoCommitMsg.systemPrompt" (ja):
  "サブジェクトは必ず日本語で記述する"
  → "You MUST write the subject in Japanese"
```

### Consequence

When `lang="ja"`, the model generates Japanese commit messages. Japanese generic messages like:

| Japanese generic message | Would be detected? | Why |
|---|---|---|
| `chore: 変更を適用` | ✅ Yes (length 11 < 12) | Caught by the `m.length < 12` gate |
| `chore: 変更を適用しました` | ❌ No (15 chars) | Doesn't match any English pattern |
| `fix: バグを修正しました` | ❌ No (14 chars) | Doesn't match any English pattern |
| `feat: 機能を追加` | ❌ No (12 chars) | Body `機能を追加` is 5 chars, passes length check (≥12) but not an English pattern |
| `chore: ファイルを更新` | ❌ No (13 chars) | Doesn't match any English pattern |

Since `isGenericMessage()` returns `false` for these, `refineMessageIfGeneric()` is **never called**. The generic Japanese message goes straight to commit.

### Gap between deepseek-v4-pro and gpt-5.4-mini

gpt-5.4-mini is more likely to generate short, generic Japanese messages (e.g., `fix: 修正しました`) that fall just above the 12-char length threshold. DeepSeek v4 Pro tends to produce longer, more specific messages even in Japanese.

### Fix suggestion

Add Japanese generic patterns to `GENERIC_MESSAGE_PATTERNS`:

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

Alternatively, extract generic Japanese keywords and add a language-aware check inside `isGenericMessage`:

```typescript
function isGenericMessage(message: string, lang?: string): boolean {
  const m = message.trim();
  if (m.length < 12) return true;
  if (GENERIC_MESSAGE_PATTERNS.some((p) => p.test(m))) return true;
  // Japanese-specific generic check
  if (lang === "ja") {
    const body = m.replace(/^\w+(\(.*?\))?!?:\s*/, "");
    if (/^(変更|修正|更新|対応|追加|削除|改善|実装|作成)(を)?(適用|反映|実施|修正)?(しました|いたしました|を行いました)?$/.test(body)) {
      return true;
    }
  }
  return false;
}
```

---

## Issue 2: `sanitizeCommitMessage` does not strip model chatter (prefixes, fences, explanations)

**Severity:** 🔴 CRITICAL
**File:** `src/core/commit-message.ts`, lines 120–170

### Root cause

`sanitizeCommitMessage` only:
1. Trims whitespace
2. Removes trailing period (`.`)
3. Validates or rewrites Conventional Commits format
4. Truncates long subjects

It does **not** handle:
- **Prefix chatter**: `"Here is the commit message: feat: add login"`, `"Sure! Here's your commit:"`, `"コミットメッセージ: feat: ログイン追加"`
- **Markdown fences**: ` ```\nfeat: add login\n``` `
- **Post-message explanations**: `"feat: add login\n\nThis commit adds the login feature."`
- **Quotes**: `'"feat: add login"'` or `'「feat: ログイン追加」'`

### Consequence

When gpt-5.4-mini (or any small model) adds explanatory text, the sanitizer produces malformed output:

| Model output | After sanitize | Problem |
|---|---|---|
| `Here is the commit message: feat: add login` | `chore: feat: add login` | Double-prefixed; wrong type |
| ` ```\nfeat: add login\n``` ` | `chore: add login\n```` | Fence leaks; wrong type |
| `Sure! feat: add login form for auth` | `chore: Sure! feat: add login form for auth` | Prefix not removed |

The colon-fallback path (line 158) is the culprit: it finds the first colon in the string and treats everything after it as the subject. But the first colon is often in the chatter prefix.

### Gap between deepseek-v4-pro and gpt-5.4-mini

DeepSeek v4 Pro reliably follows "Return ONLY the commit message string. No explanations or code fences." gpt-5.4-mini frequently adds prefixes, markdown fences, or explanations.

### Fix suggestion

Add a pre-cleaning step in `sanitizeCommitMessage`:

```typescript
export function sanitizeCommitMessage(message: string, files?: string[]): string {
  let sanitized = message.trim();

  // --- NEW: Strip model chatter ---

  // 1. Extract from markdown code fences
  const fenceMatch = sanitized.match(/```(?:\w+)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    sanitized = fenceMatch[1].trim();
  }

  // 2. Strip common prefix patterns
  sanitized = sanitized.replace(
    /^(here\s+is\s+the\s+commit\s+message\s*:?\s*|sure!?\s*(here\s+is\s+)?\s*:?\s*|コミットメッセージ\s*:?\s*|commit\s+message\s*:?\s*)/i,
    ""
  ).trim();

  // 3. Remove quotes/brackets wrapping the entire message
  sanitized = sanitized.replace(/^["'「『](.*)["'」』]$/, "$1").trim();

  // 4. Take only the first line (discard multi-line explanations)
  const firstLine = sanitized.split(/\n/)[0].trim();
  if (firstLine && firstLine.length >= 6) {
    sanitized = firstLine;
  }

  // --- Existing logic ---
  sanitized = sanitized.replace(/\.$/, "");
  // ... rest unchanged
```

---

## Issue 3: AI comparison uses the same model that generated the bad message

**Severity:** 🟡 HIGH
**File:** `src/core/auto-commit-message.ts`, lines 176–263 (`refineMessageIfGeneric`)

### Root cause

When `refineMessageIfGeneric` decides to use AI comparison (line 219), it calls `aiComplete(ctx, ...)` with the **same model** that generated the original (generic) commit message. There is no separate "judge model" configuration.

```typescript
// auto-commit-message.ts:219-225
const result = await aiComplete(ctx, {
  systemPrompt: t(lang, "autoCommitMsg.compareSystemPrompt"),
  userMessage: comparisonPrompt,
  maxTokens: 100,
  temperature: 0,
});
```

### Consequence

If gpt-5.4-mini is bad at generating specific commit messages, it is also likely bad at:

1. Following the terse "return only A or B" instruction
2. Accurately judging which message is more specific
3. Understanding the nuance of the comparison

The output is either an unparseable response (falls through to substring matching, then to default `generatedMessage`) or a wrong vote.

This creates a feedback loop: the same weak model that produced the bad output is asked to judge it, and its judgment is unreliable.

### Gap between deepseek-v4-pro and gpt-5.4-mini

DeepSeek v4 Pro rarely triggers this path (its messages are already specific). When it does, its comparison is reliable. gpt-5.4-mini frequently triggers this path and then fails at comparison.

### Fix suggestion

**Option A (simpler):** After the heuristic quick-guard fails, skip the AI comparison entirely for small/cheap models and fall through to keeping whichever has the higher `specificityScore`. This avoids burning an API call on a model that can't do comparison well.

```typescript
// After heuristic quick-guard:
// For cheap models, skip AI comparison and use heuristic winner
const HEURISTIC_ONLY_MODELS = ["gpt-5.4-mini", "claude-haiku", /* etc */];
if (HEURISTIC_ONLY_MODELS.includes(ctx.model)) {
  return userScore > genScore ? userCandidate : generatedMessage;
}
```

**Option B (more robust):** Allow configuring a separate "judge model" that is used only for the comparison step. Even a slightly better model for this one call would improve results.

---

## Issue 4: Comparison vote parsing is fragile with small models

**Severity:** 🟡 MEDIUM
**File:** `src/core/auto-commit-message.ts`, lines 235–257

### Root cause

The vote parsing logic:

```typescript
const voteA = /\bA\b/i.test(text) && !/\bB\b/i.test(text);
const voteB = /\bB\b/i.test(text) && !/\bA\b/i.test(text);
```

This fails when the model output contains **both** "A" and "B" (e.g., "Both A and B are good, but A is better"). In that case, `voteA` is `false` (B exists), `voteB` is `false` (A exists), and it falls through to the unreliable substring fallback.

### Actual failure modes for small models:

| Model output | voteA | voteB | Result |
|---|---|---|---|
| `A` | ✅ true | — | generatedMessage ✅ |
| `B` | — | ✅ true | userCandidate ✅ |
| `I think A is better` | ✅ true | — | generatedMessage ✅ |
| `Both A and B are good, but A is more specific` | ❌ false | ❌ false | Falls to substring |
| `A or B - hard to say, maybe A` | ❌ false | ❌ false | Falls to substring |
| `B です` (Japanese) | ❌ false | ✅ true | userCandidate ✅ |

### Consequence

When the model can't decide, the substring fallback is used. This checks if the first 15 characters of either candidate appear in the response:

```typescript
if (userCandidate.length >= 15 && text.includes(userCandidate.substring(0, 15))) {
  return userCandidate;
}
if (generatedMessage.length >= 15 && text.includes(generatedMessage.substring(0, 15))) {
  return generatedMessage;
}
```

This is unreliable because:
- A typical "both are good" response doesn't quote either message verbatim
- If either message is shorter than 15 chars, the check is skipped entirely
- The default fallback always returns `generatedMessage`, meaning user candidates systematically lose tie-breaks

### Fix suggestion

Add a "last letter wins" regex as a more robust tiebreaker:

```typescript
// Try explicit single-letter vote first (existing)
const voteA = /\bA\b/i.test(text) && !/\bB\b/i.test(text);
const voteB = /\bB\b/i.test(text) && !/\bA\b/i.test(text);
if (voteA) return generatedMessage;
if (voteB) return userCandidate;

// NEW: If both appear, pick the one that appears last (common in "Both X, but Y" patterns)
const aPos = text.search(/\bA\b/i);
const bPos = text.search(/\bB\b/i);
if (aPos >= 0 && bPos >= 0) {
  return bPos > aPos ? userCandidate : generatedMessage;
}

// Fallback to substring matching (existing)
// ...
```

Also, consider adding a **parseable instruction** to the prompt: wrap the vote in markers like `<VOTE>A</VOTE>` to make parsing trivial for both the model and the parser.

---

## Issue 5: `specificityScore` is heavily English-biased — unfair comparison for Japanese

**Severity:** 🟡 HIGH (affects correctness when refinement IS triggered)
**File:** `src/core/auto-commit-message.ts`, lines 128–171

### Root cause

The scoring function has two tiers:

**Tier 1 (always runs):** English-only
- `genericWords`: `/\b(change|update|modify|fix|apply|commit|files?|stuff|things?)\b/gi` — uses `\b` word boundaries that don't work on Japanese
- `specificTerms`: `/\[A-Z\][a-z]+|[a-z]+[A-Z]|[A-Z]{2,}/g` — matches CamelCase/ALL_CAPS, never matches Japanese
- `concreteVerbs`: long list of English verbs — no Japanese equivalents

**Tier 2 (only when `lang === "ja"`):**
- Kanji count: up to +5 points (10 kanji × 0.5)
- Katakana terms: +2 per term
- Single-word penalty: −4 for exact matches like `変更`, `修正`

**Weight comparison:**
- English `specificTerms` (CamelCase): +3 per match
- English `concreteVerbs`: +2 per match
- English `genericWords`: −2 per match
- Japanese kanji: +0.5 per char (max +5)
- Japanese katakana: +2 per term

A moderately specific English message like `feat: add LoginForm component` gets:
- Length: ~17 × 0.3 = 5.1
- `specificTerms`: "LoginForm" = +3
- `concreteVerbs`: "add" = +2
- **Total: ~10.1**

A moderately specific Japanese message like `feat: ログインフォームを追加` gets:
- Length: ~12 × 0.3 = 3.6
- No English bonuses (no CamelCase, no English verbs)
- Japanese: kanji (追, 加) = 2 × 0.5 = 1.0
- Katakana: "ログインフォーム" = +2
- **Total: ~6.6**

The English message scores ~53% higher despite being equivalently specific.

### Consequence

In `refineMessageIfGeneric`'s heuristic quick-guard:

```typescript
const genScore = specificityScore(generatedMessage, lang);
const userScore = specificityScore(userCandidate, lang);
if (userScore > genScore + 5) return userCandidate;
if (genScore > userScore + 5) return generatedMessage;
```

A Japanese `userCandidate` is systematically disadvantaged against an English `generatedMessage`. The +5 threshold means the Japanese candidate needs to be dramatically more specific to win. Even when it's a clearly better message, the scoring may not reflect it.

### Fix suggestion

Increase Japanese scoring weights to parity:

```typescript
if (lang === "ja") {
  const kanjiCount = (m.match(/[\u4e00-\u9faf]/g) || []).length;
  score += Math.min(kanjiCount, 15) * 1.0;  // was 0.5 → 1.0

  const katakanaTerms = m.match(/[\u30a0-\u30ff]{2,}/g) || [];
  score += katakanaTerms.length * 3;  // was 2 → 3

  // Also reward Japanese concrete verbs (parallel to English concreteVerbs)
  const japaneseConcreteVerbs = /(追加|実装|作成|削除|修正|改善|整理|統合|分割|移行|更新|導入|廃止|対応)/g;
  score += (m.match(japaneseConcreteVerbs) || []).length * 2;

  // Penalize Japanese generic words
  const japaneseGenericWords = /(変更|修正|更新|対応|適用|反映)/g;
  const jpGenericCount = (m.match(japaneseGenericWords) || []).length;
  score -= jpGenericCount * 2;
}
```

---

## Issue 6: `isValidCommitSubject` has no English guard — but low impact

**Severity:** 🔵 LOW
**File:** `src/core/auto-commit-message.ts`, lines 70–81

### Root cause

```typescript
function isValidCommitSubject(body: string, lang: string): boolean {
  if (lang === "ja") {
    if (body.endsWith("…")) return false;
    if (body.length < 3) return false;
    if (CONVERSATIONAL_MARKERS_JA.some((p) => p.test(body))) return false;
  }
  return true;
}
```

For non-Japanese languages, it always returns `true`. English conversational markers like:
- "can you add a login form"
- "could you please fix the bug"
- "I'd like you to refactor"

...would pass through as valid commit subjects.

### Impact

Low because `userMessageToCandidate` already strips `please`, and the `userCandidate` would typically be cleaned up enough. But a pure English user message like "can you add a login form" would become `feat: can you add a login form` which is poor quality.

### Fix suggestion

Add English conversational markers:

```typescript
const CONVERSATIONAL_MARKERS_EN: RegExp[] = [
  /^(can|could|would|will|please)\s/i,
  /^(i\s|we\s|you\s)/i,
  /^(add|fix|create|remove|update|change)\s+a\s/i,  // "add a login" → conversational
  /[?.!]$/,  // Ends with punctuation (conversational)
];
```

---

## Issue 7: `userMessageToCandidate` cleanup `して$` is over-aggressive

**Severity:** 🔵 LOW
**File:** `src/core/auto-commit-message.ts`, line 87

### Root cause

```typescript
.replace(/して$/, "")
```

This matches the last two characters `して` in any context. While it correctly strips the て-form ending from constructions like `〜を追加して`, it could also strip meaningful text. For example:

- `設定を初期化して` → `設定を初期化` ✅ (correct)
- `パスワードをリセットして` → `パスワードをリセット` ✅ (correct)
- `ドキュメントを整備して、テストを追加` → The chain processes sequentially, so `して$` only checks the very end after all prior replacements. Since after stripping `。`, the text ends with `追加`, not `して`. ✅ (no false match in this case)

### Impact

Low. The cleanup chain processes markers from longest to shortest (`お願いします$` → `してください$` → `して$`), so `して$` only fires as a fallback for bare て-form endings. This is generally correct behavior.

---

## Issue 8: No test coverage for any of these functions

**Severity:** 🟡 MEDIUM (process risk)
**File:** All — zero test files in repository

### Evidence

```bash
$ find . -name "*.test.*" -o -name "*.spec.*"
# (empty)
```

### Impact

All the functions reviewed above — `isGenericMessage`, `specificityScore`, `userMessageToCandidate`, `isValidCommitSubject`, `sanitizeCommitMessage` — are **pure functions** (string in, string/number out). They are trivially testable. Without tests:

- Regressions from any fix are invisible
- Cross-language correctness cannot be verified
- Edge cases discovered now may be re-broken later

### Recommendation

Before fixing any of the issues above, add unit tests. The highest-value test targets:

| Function | What to test | Priority |
|---|---|---|
| `isGenericMessage` | Japanese generic messages (should return true) | CRITICAL |
| `sanitizeCommitMessage` | Prefixed output from small models (should strip chatter) | CRITICAL |
| `specificityScore` | Japanese vs English specificity parity | HIGH |
| `userMessageToCandidate` | Japanese conversational input → valid candidate | HIGH |
| `isValidCommitSubject` | English conversational markers | MEDIUM |

---

## Summary: Gap between deepseek-v4-pro (good) and gpt-5.4-mini (bad)

| # | Issue | Why it hurts gpt-5.4-mini more | Why deepseek-v4-pro is unaffected |
|---|---|---|---|
| 1 | Japanese generic detection gap | Generates short Japanese generic messages that exceed 12-char threshold | Generates longer, more specific messages naturally |
| 2 | No chatter stripping | Frequently adds "Here is the commit message:" or markdown fences | Reliably follows "Return ONLY the commit message" instruction |
| 3 | Comparison uses same weak model | When refinement is triggered, the comparison model is also weak | Rarely triggers refinement; when it does, comparison is reliable |
| 4 | Fragile vote parsing | Outputs explanations like "Both A and B are good, but A is more specific" | Outputs clean single-letter "A" or "B" |
| 5 | English-biased scoring | Japanese candidates disadvantaged in heuristic comparison | English scoring bias doesn't matter because output is already specific |

The **critical path** for gpt-5.4-mini quality degradation:

```
gpt-5.4-mini generates commit message
  → If English: may be generic, caught by isGenericMessage ✅
    → But refinement uses same weak model → comparison fails → keeps generic message ❌
  → If Japanese: may be generic, NOT caught by isGenericMessage ❌
    → Refinement never triggered → generic message goes to commit ❌❌
  → If model adds chatter: sanitizer doesn't clean → malformed message ❌
```

---

## Recommended fix priority

| Priority | Issue | Effort | Risk |
|---|---|---|---|
| 🔴 P0 | #2: Strip model chatter in `sanitizeCommitMessage` | Low (~30 lines) | Low |
| 🔴 P0 | #1: Add Japanese patterns to `isGenericMessage` | Low (~20 lines) | Low |
| 🟡 P1 | #5: Balance `specificityScore` for Japanese | Low (~20 lines) | Low |
| 🟡 P1 | #4: Robust vote parsing with fallback | Low (~15 lines) | Low |
| 🟡 P1 | #3: Skip AI comparison for known-weak models | Low (~10 lines) | Low (heuristic fallback already exists) |
| 🔵 P2 | #6: English conversational markers | Low (~15 lines) | Low |
| 🔵 P2 | #8: Add unit tests | Medium (setup) | None (only adds safety) |
