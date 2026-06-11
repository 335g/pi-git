# Prompt Engineering Review: Small Model Commit Message Generation

## Executive Summary

The gap between deepseek-v4-pro (good results) and gpt-5.4-mini (abstract/uninformative results) is explained by **5 critical/high-severity issues** in `auto-commit-message.ts`, all stemming from treating all model sizes identically. Large models can infer intent from weak prompts; small models need explicit structure, constraints, and cleanup.

---

## Issue 1 — CRITICAL: No output format cleanup (the #1 gap explainer)

**Files:** `src/core/auto-commit-message.ts` (lines 262–277), `src/core/diff-analyzer.ts` (lines 114–165)

**Problem:** Small models habitually produce verbose/chatty output — they wrap the actual answer in explanations, markdown fences, or conversational filler. `diff-analyzer.ts` has a robust 4-layer `parseHunks()` that handles all of these:

| Layer | Strategy |
|-------|----------|
| 1 | Strip ` ```json ``` ` code fences |
| 2 | Direct `JSON.parse` |
| 3 | Strip trailing non-JSON text, retry `JSON.parse` |
| 4 | Regex pair extraction from malformed JSON |

`auto-commit-message.ts` has **none of this**. The raw `result.text` is passed straight to `sanitizeCommitMessage()` with no pre-processing.

**Concrete failure modes for small models:**

| Small model output | What happens | What should happen |
|---|---|---|
| `Here is the commit message:\n\nfeat: add login` | `sanitizeCommitMessage` sees first `:` at "message:" and produces garbage like `chore: add login` (with "Here is the commit message\n\n" truncated by type inference) | Extract `feat: add login` |
| ` ```\nfeat: add login\n``` ` | `isConventionalCommit` fails (starts with backtick). Falls through to colon-split path, producing `chore: add login\n`` ` — backticks leak into commit message | Strip fences, extract `feat: add login` |
| `feat: add login\n\nThis commit adds login functionality.` | `isConventionalCommit` fails (regex `$` doesn't match before extra lines without multiline flag). Falls through, leaks trailing text into subject | Take first line only |
| `Based on the user's request, I believe the commit should be:\nfeat(auth): add login form with validation` | Whole preamble becomes the commit message body | Extract the Conventional Commit line |
| `chore: apply changes` (literally) | Passes sanitization, caught by `isGenericMessage()` → refinement path | May still end up generic if refinement fails |

**Why this disproportionately affects small models:** Large models follow instructions better and are less likely to add preamble/postamble. Small models have weaker instruction-following and default to chatty output even when told "Return ONLY the commit message."

**Fix suggestion — add `cleanCommitOutput()` before sanitization:**

```typescript
// In auto-commit-message.ts, before sanitizeCommitMessage call:

function cleanCommitOutput(raw: string): string {
  let text = raw.trim();

  // Layer 1: Extract from markdown fences
  const fenceMatch = text.match(/```(?:[\w]*\n)?([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Layer 2: Remove common chat prefixes
  const prefixPatterns = [
    /^(?:here\s+is\s+(?:the\s+)?(?:commit\s+)?message[:\s]*)/i,
    /^(?:commit\s+message[:\s]*)/i,
    /^(?:the\s+commit\s+message\s+(?:is|should\s+be)[:\s]*)/i,
    /^(?:提案するコミットメッセージ[:\s]*)/,
    /^(?:コミットメッセージ[:\s]*)/,
    /^(?:以下がコミットメッセージです[:\s]*)/,
  ];
  for (const pat of prefixPatterns) {
    text = text.replace(pat, "").trim();
  }

  // Layer 3: Take only the first non-empty line that looks like Conventional Commit
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const ccLine = lines.find(l => /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+?\))?!?:\s/.test(l));
  if (ccLine) return ccLine;

  // Layer 4: Fall back to first non-empty line
  return lines[0] || text;
}
```

---

## Issue 2 — CRITICAL: maxTokens=1024 incentivizes verbose output in small models

**Files:** `src/core/ai.ts` (line 42), `src/core/auto-commit-message.ts` (lines 262–267)

**Problem:** `aiComplete` defaults to `maxTokens: 1024`. `generateAutoCommitMessage` passes no `maxTokens` override, so it uses the default. A valid commit message is ~15-30 tokens. Giving 1024 maxTokens to a small model encourages it to "fill the budget" — small models often interpret high maxTokens as permission to be verbose. They produce explanations, alternatives, and commentary to use the space.

**Contrast with `diff-analyzer.ts`:** Also uses 1024, but that's appropriate for a JSON array of multiple hunks. A single-line commit message does not need 1024 tokens.

**Why this disproportionately affects small models:** Large models respect output constraints regardless of budget. Small models interpret high maxTokens as an implicit instruction to produce substantial output.

**Fix suggestion:**

```typescript
// In generateAutoCommitMessage(), change aiComplete call to:
const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(...),
  maxTokens: 200,   // A single-line commit message needs ~30 tokens
  temperature: 0,
});
```

---

## Issue 3 — HIGH: Few-shot examples are only in user prompt, not system prompt

**Files:** `src/i18n/messages.ts` (keys `autoCommitMsg.systemPrompt` and `autoCommitMsg.examples`), `src/core/auto-commit-message.ts` (lines 262-267, `buildPrompt` function)

**Problem:** The few-shot examples (`autoCommitMsg.examples`) are injected into the **user prompt** via `buildPrompt()`, not the **system prompt** via `getSystemPrompt()`. For small models, examples in the system prompt serve as behavioral anchors — they establish the expected format before any user content is shown. When examples are buried in the user prompt (which can be 8000+ chars of diff + conversation history), the model's attention is diluted by the time it reaches them.

**Current structure:**
```
System: "You are a commit message generator. Rules: choose type, write English, keep under 50 chars, imperative mood, scope if inferable. Return ONLY the message."
User:   "{examples}\n\n=== USER REQUEST ===\n...\n=== ASSISTANT RESPONSE ===\n...\n=== CHANGED FILES ===\n...\n=== GIT DIFF ===\n...\n\nGenerate a message."
```

**Contrast with `diff-analyzer.ts`:** Same issue — examples are in the user prompt there too. However, `diff-analyzer.ts` compensates with: (a) explicit JSON format in the system prompt, (b) type hints, (c) robust parsing fallbacks. `auto-commit-message.ts` has none of these compensations.

**Why this disproportionately affects small models:** Small models rely more heavily on in-context examples. Large models can generalize from rules alone. Moving examples into the system prompt gives small models a clear behavioral template before they process the noisy user content.

**Fix suggestion — move examples into system prompt:**

```
// English system prompt (autoCommitMsg.systemPrompt):
"You are a commit message generator. Output ONLY a Conventional Commit message, one line, no explanation.

Examples:
User: 'Add a login form to the auth page' | Assistant: 'Added login.tsx with form validation' | Files: src/auth/login.tsx, src/auth/api.ts
→ feat(auth): add login form

User: 'Fix null pointer in payment' | Assistant: 'Added null check in PaymentProcessor' | Files: src/payment/processor.ts
→ fix(payment): add null check in processor

Rules:
- Type: feat, fix, docs, style, refactor, test, chore
- Language: English
- Max 50 characters
- Imperative mood
- Include scope only if clearly inferable

Return ONLY the message. No markdown, no explanation."
```

Remove `{examples}` from `buildPrompt` template, or keep a simplified version.

---

## Issue 4 — HIGH: No type hints / file-path scaffolding (unlike diff-analyzer)

**Files:** `src/core/diff-analyzer.ts` (lines 56–88, `buildTypeHint()`), `src/core/auto-commit-message.ts` (no equivalent)

**Problem:** `diff-analyzer.ts` has `buildTypeHint()` which analyzes file paths and groups them by inferred Conventional Commit type (feat, fix, test, docs, etc.). This is prepended to the user prompt as explicit guidance. `auto-commit-message.ts` has **no equivalent scaffolding** for the AI.

**`diff-analyzer.ts` scaffolding:**
```
Type hints (based on file paths):
feat: src/auth/login.tsx, src/auth/api.ts
docs: README.md
test: src/auth/login.test.tsx
```

**`auto-commit-message.ts`:** Sends the raw file list as a comma-separated string (truncated to 500 chars) with no type hints.

**Why this disproportionately affects small models:** Small models have less world knowledge and weaker reasoning. Telling them explicitly "these files look like a feature change" removes ambiguity. Large models can infer this from file paths on their own.

**Fix suggestion:** Reuse `inferTypeFromFiles` from `commit-message.ts` to generate type hints:

```typescript
// In buildPrompt() or generateAutoCommitMessage():
import { inferTypeFromFiles } from "./commit-message.js";

function buildTypeHintForMessage(files: string[]): string {
  const type = inferTypeFromFiles(files);
  if (type === "chore") return ""; // skip if generic
  return `Hint: based on file paths, the likely commit type is "${type}".\n`;
}
```

---

## Issue 5 — HIGH: Japanese generation forces small models' weakest capability

**Files:** `src/i18n/messages.ts` (line: `autoCommitMsg.systemPrompt` in `ja`), `src/core/auto-commit-message.ts` (line 240: `getSystemPrompt(lang)`)

**Problem:** When `lang="ja"`, the system + user prompts both instruct the model to generate Japanese commit messages:
- System: "サブジェクトは必ず日本語で記述する"
- User: "**必ず日本語で**生成してください"

Small models have significantly weaker Japanese generation capability. Their Japanese vocabulary is smaller, and they default to generic/abstract phrases like "変更を適用" (apply changes), "機能を追加" (add feature), or "修正" (fix) because these are the most common patterns in their limited Japanese training data.

**Contrast:** The English prompt just says "Write the subject in English" — small models handle English much better because their training data is predominantly English. They can generate specific, concrete English phrases.

**Why this disproportionately affects small models:** Large models have sufficient Japanese capacity to generate specific, idiomatic Japanese commit messages. Small models don't — they fall back to boilerplate.

**Fix suggestion — consider two-tier approach:**

Option A (simple): For small models, always generate in English regardless of `lang` setting, then optionally machine-translate the result.

Option B (structural): Add a `model_size` hint. When using a small model with `ja`:
```
System prompt for ja + small model:
"Generate a Conventional Commit message. Write the subject in Japanese.
If you cannot produce specific, concrete Japanese, write in English instead.
NEVER use generic messages like '変更を適用' or '機能を追加'.
Instead, describe WHAT specifically changed (e.g. 'ログインフォームのバリデーションを追加')."
```

---

## Issue 6 — MEDIUM: System prompt is too verbose for small models

**Files:** `src/i18n/messages.ts` (key `autoCommitMsg.systemPrompt` in both `en` and `ja`)

**Problem:** The system prompt is 5-7 sentences of instructions. Small models lose focus with long prompts. The current English system prompt:

```
You are a commit message generator. From the following information, understand what
changes were made and generate a single Conventional Commit message.

The GIT DIFF is the most reliable source of what actually changed. Use it as the
primary driver for the commit message. The user's request provides intent, and the
assistant's response and changed files list are supplementary.

Rules:
- Choose type from: feat, fix, docs, style, refactor, test, chore
- Write the subject in English
- Keep subject under 50 characters
- Use imperative mood
- Include scope only if clearly inferable from the diff

Return ONLY the commit message string. No explanations or code fences.
```

The paragraph about "GIT DIFF is the most reliable source" is contextual reasoning that a large model can use but a small model wastes attention on. Small models perform better with terse, imperative instructions.

**Fix suggestion:** Split into a "small model" variant:

```
"Generate a Conventional Commit message. ONE LINE ONLY.

RULES (must follow):
1. Type: feat, fix, docs, style, refactor, test, chore
2. Language: English
3. Max 50 chars
4. Output: message ONLY, no other text

EXAMPLES:
→ feat(auth): add login form
→ fix(payment): add null check in processor
→ docs: fix typo in README"
```

---

## Issue 7 — MEDIUM: No multiline cleanup in sanitizeCommitMessage

**Files:** `src/core/commit-message.ts` (lines 81–140, `sanitizeCommitMessage()`)

**Problem:** `sanitizeCommitMessage` uses regex `/^(\w+)(\([^)]+\))?(!)?:\s*(.+)$/` without the `m` (multiline) flag. When a small model produces:

```
feat: add login form

This commit implements the login form that was requested.
```

The `.` in `(.+)` doesn't match newlines (no `s` flag), so `.+` captures `"add login form"` but `$` can't match because the string doesn't end there. The regex fails entirely, and `isConventionalCommit` returns false. The function then falls through to the colon-split path, which finds the first `:` and treats everything after it as the subject — producing multi-line commit messages with leaked postamble text.

**Fix suggestion:** In `sanitizeCommitMessage`, take only the first line before processing:

```typescript
export function sanitizeCommitMessage(message: string, files?: string[]): string {
  // Take only the first non-empty line
  const firstLine = message.split("\n").map(l => l.trim()).find(l => l.length > 0) || message;
  let sanitized = firstLine.trim();
  // ... rest of function
}
```

---

## Issue 8 — LOW: Similar user-prompt bloat as diff-analyzer

**Files:** `src/core/auto-commit-message.ts` (lines 208–253, `buildPrompt()`)

**Observation:** The user prompt can reach 8000+ characters, combining conversation history, file lists, and diff content. Small models have limited effective context windows and attention dilutes over long prompts. The examples and critical instruction ("Return ONLY the message") are at the tail end of this long prompt.

This is less severe than the other issues because:
- `diff-analyzer.ts` has the same problem and works (due to JSON parsing fallbacks)
- Truncation budgets are already in place (1500 user chars, 600 assistant chars, 5000 diff chars)

However, for small models it would be better to put the "Return ONLY..." constraint as a **prefix** (first thing they read) rather than a suffix, since small models' attention decays over the prompt length.

---

## Summary: Which Issues Explain the deepseek-v4-pro vs gpt-5.4-mini Gap

| Issue | Severity | Why it hits small models harder |
|-------|----------|--------------------------------|
| #1 — No output cleanup | **CRITICAL** | Small models add chatty preamble/postamble; large models rarely do |
| #2 — maxTokens=1024 | **CRITICAL** | Small models fill budget with filler; large models respect constraints |
| #3 — Examples in user prompt only | **HIGH** | Small models need in-context behavioral anchors; large models generalize from rules |
| #4 — No type hints | **HIGH** | Small models have weaker reasoning; explicit type hints reduce ambiguity |
| #5 — Japanese generation | **HIGH** | Small models have much weaker non-English capability |
| #6 — Verbose system prompt | **MEDIUM** | Small models lose focus on long instructions |
| #7 — No multiline cleanup | **MEDIUM** | Small models output multi-line; large models output single-line |
| #8 — Prompt bloat | **LOW** | Contributes to attention dilution in combination with #3 |

## Recommended Fix Priority

1. **Add `cleanCommitOutput()`** (Issue #1) — highest ROI, handles the most common small-model failure mode
2. **Reduce maxTokens to 200** (Issue #2) — trivial change, large impact
3. **Move examples into system prompt** (Issue #3) — structural improvement to prompt design
4. **Add file-based type hints** (Issue #4) — reuse existing `inferTypeFromFiles`
5. **Consider English-only or dual-path for small models** (Issue #5) — more complex, good follow-up
6. **Add first-line extraction in sanitizeCommitMessage** (Issue #7) — defensive fix

Issues #6 and #8 are lower priority and can be addressed after the critical issues are fixed.
