# P2 Implementation Plan: Small Model Commit Message — Follow-ups

**Date:** 2026-06-11
**Status:** Final (v2) — Ready for Implementation
**Review:** 1 P2 plan review → plan updated
**Based on:** Plan v3 (P0/P1 implemented), source reviews (budget-truncation #3/#4, refinement-heuristics #6, prompt-engineering #7/#8)
**Prerequisite:** P0 + P1 already implemented in `src/core/auto-commit-message.ts` and `src/i18n/messages.ts`

---

## Goal

Address the 4 deferred P2 improvements that are not critical for the core small-model fix but improve correctness, safety, and testability.

---

## P2-1: Newline-boundary diff truncation

**Severity:** Low-Medium
**Source:** Budget-truncation review Issue #4
**File:** `src/core/auto-commit-message.ts`

### Problem

`buildPrompt` currently calls `truncate(cleanedDiff, MAX_DIFF_CHARS)` which cuts at **space boundaries**. Diff lines don't have natural-language "words" — a space-boundary cut can break in the middle of:

- `@@ -1,5 +1,7 @@` (hunk header)
- `+   const x` (added line)
- `-   return oldValue;` (removed line)

This produces syntactically invalid diff fragments. Small models already struggle with raw diffs; broken syntax makes it worse.

### Fix

**Don't create a new function.** `diff-analyzer.ts` already has a structurally identical `truncateDiff` function (line 193) that cuts at newline boundaries:

```typescript
// diff-analyzer.ts:193-198 (EXISTING)
function truncateDiff(diff: string, maxBytes: number): string {
  if (diff.length <= maxBytes) return diff;
  const slice = diff.substring(0, maxBytes);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.substring(0, lastNewline) : slice;
}
```

**Step 1:** Export `truncateDiff` from `diff-analyzer.ts`:
```diff
- function truncateDiff(diff: string, maxBytes: number): string {
+ export function truncateDiff(diff: string, maxBytes: number): string {
```

**Step 2:** Import in `auto-commit-message.ts` (add to existing import):
```diff
- import { stripDiffNoise } from "./diff-analyzer.js";
+ import { stripDiffNoise, truncateDiff } from "./diff-analyzer.js";
```

**Step 3:** Replace in `buildPrompt`:
```diff
- diffSection = truncate(cleaned, MAX_DIFF_CHARS);
+ diffSection = truncateDiff(cleaned, MAX_DIFF_CHARS);
```

**Changes:** 3 lines across 2 files. No new function, no DRY violation.

---

## P2-2: English conversational markers in `isValidCommitSubject`

**Severity:** Low
**Source:** Refinement-heuristics review Issue #6
**File:** `src/core/auto-commit-message.ts`

### Problem

`isValidCommitSubject` only validates Japanese (`lang === "ja"`). For English, it always returns `true`. English conversational patterns pass through as valid commit subjects:

| User input | Candidate produced | `isValidCommitSubject` | Problem |
|-----------|-------------------|----------------------|---------|
| `"can you add a login form"` | `feat: can you add a login form` | `true` (no check) | "can you" is conversational |
| `"could you please fix the bug"` | `fix: could you please fix the bug` | `true` (no check) | "could you please" remains |
| `"I'd like you to refactor auth"` | `refactor: I'd like you to refactor auth` | `true` (no check) | "I'd like you to" is conversational |

In practice, these candidates typically lose in heuristic comparison to the AI-generated message, but defense-in-depth is warranted.

### Fix

Add English conversational markers to `isValidCommitSubject`:

```typescript
/** English conversational markers — patterns a user message starts with */
const CONVERSATIONAL_MARKERS_EN: RegExp[] = [
  /^(can|could|would|will)\s+you\s/i,
  /^please\s/i,
  /^(i|we)\s+(would\s+like|want|need)\s+(you\s+)?to\s/i,
  /^(i'?d\s+like\s+(you\s+)?to\s)/i,
  /^let'?s\s/i,
];
```

> **Note:** The plan review identified that `/^(add|fix|create|remove|update|change)\s+(a|an|the|some)\s/i` would false-positive on legitimate descriptive subjects like `fix a null pointer` or `add a new endpoint`. This pattern is intentionally excluded. The conversational markers above (`can you`, `please`, `I'd like`, `let's`) catch the truly problematic chat patterns without false-positives.

Update the function body:
```typescript
function isValidCommitSubject(body: string, lang: string): boolean {
  if (lang === "ja") {
    // ... existing Japanese checks ...
  } else {
    // English conversational markers
    if (CONVERSATIONAL_MARKERS_EN.some((p) => p.test(body))) return false;
    // Question marks or exclamation marks indicate conversational tone
    if (/[?!]$/.test(body)) return false;
    // Too short to carry meaning
    if (body.length < 3) return false;
  }
  return true;
}
```

**Changes:** ~20 lines (new constant + function body restructuring).

---

## P2-3: Unit tests for key functions

**Severity:** Medium (process risk)
**Source:** Refinement-heuristics review Issue #8
**File:** New: `src/core/__tests__/auto-commit-message.test.ts` (or similar)

### Problem

All critical functions are pure (string in → string/number out) but have zero test coverage:

| Function | Pure? | Test priority |
|----------|-------|--------------|
| `isGenericMessage` | ✅ | **CRITICAL** — Japanese patterns must be verified |
| `cleanCommitOutput` | ✅ | **CRITICAL** — 4-layer extraction must handle all edge cases |
| `specificityScore` | ✅ | HIGH — Japanese/English parity |
| `sanitizeCommitMessage` | ✅ | HIGH — chatter stripping via cleanCommitOutput |
| `userMessageToCandidate` | ✅ | MEDIUM — type inference + truncation |
| `isValidCommitSubject` | ✅ | MEDIUM — English markers (P2-2) |
| `isCheapModel` | ✅ | LOW — regex matching, stable |
| `getBudgetMultiplier` | ✅ | LOW — wraps isCheapModel |
| `truncateDiffAtNewline` | ✅ | LOW — simple string operation |
| `buildTypeHintForMessage` | ✅ | LOW — wraps inferTypeFromFiles |

### Fix

Add a test file with focused test cases. Use the project's existing test framework (none currently configured — need to set up). If no framework exists, use Node's built-in `node:test` or add `vitest` as a dev dependency.

**Minimal test cases for `isGenericMessage`:**

```typescript
// Japanese generic messages MUST be detected
test("isGenericMessage detects Japanese generic patterns", () => {
  expect(isGenericMessage("fix: 修正しました")).toBe(true);
  expect(isGenericMessage("chore: 変更を適用")).toBe(true);
  expect(isGenericMessage("feat: 機能を追加")).toBe(true);
  expect(isGenericMessage("chore: ファイルを更新しました")).toBe(true);
});

// Japanese specific messages MUST NOT be detected as generic
test("isGenericMessage allows specific Japanese messages", () => {
  expect(isGenericMessage("feat: ログインフォームを追加")).toBe(false);
  expect(isGenericMessage("fix: nullチェックを追加")).toBe(false);
  expect(isGenericMessage("chore: 依存関係を更新")).toBe(false);
  expect(isGenericMessage("feat: 削除機能を追加")).toBe(false); // 削除 in compound
});
```

**Minimal test cases for `cleanCommitOutput`:**

```typescript
test("cleanCommitOutput extracts from markdown fences", () => {
  expect(cleanCommitOutput("```\nfeat: add login\n```")).toBe("feat: add login");
});

test("cleanCommitOutput strips chat prefixes", () => {
  expect(cleanCommitOutput("Here is the commit message: feat: add login"))
    .toBe("feat: add login");
  expect(cleanCommitOutput("コミットメッセージ: feat: ログイン追加"))
    .toBe("feat: ログイン追加");
});

test("cleanCommitOutput strips backtick wrapping", () => {
  expect(cleanCommitOutput("`feat: add login`")).toBe("feat: add login");
});

test("cleanCommitOutput picks first CC line from multiple options", () => {
  const input = "feat: add login\nfix: resolve bug\nchore: update deps";
  expect(cleanCommitOutput(input)).toBe("feat: add login");
});

test("cleanCommitOutput handles Japanese fence info strings", () => {
  expect(cleanCommitOutput("```コミットメッセージ\nfeat: ログインを追加\n```"))
    .toBe("feat: ログインを追加");
});
```

**Test infrastructure setup:**

The project has no existing test infrastructure. Use `node:test` (built into Node 18+, zero dependencies) with `tsx` as the TypeScript loader.

**Step 1:** Add dev dependency:
```bash
npm install --save-dev tsx
```

**Step 2:** Add `"test"` script to `package.json`:
```json
"scripts": {
    "test": "node --import tsx --test src/**/*.test.ts",
    "build": "tsc",
    "prepublishOnly": "npm run build"
}
```

**Step 3:** Exclude test files from build output in `tsconfig.json` (currently `include: ["src/**/*.ts"]` would compile tests into dist):
```json
"exclude": ["src/**/__tests__/**", "node_modules"]
```

**Missing test cases to add (from review gaps):**

1. **English generic patterns for `isGenericMessage`**:
```typescript
test("isGenericMessage detects English generic patterns", () => {
  expect(isGenericMessage("chore: apply changes")).toBe(true);
  expect(isGenericMessage("chore: update files")).toBe(true);
  expect(isGenericMessage("chore: commit changes")).toBe(true);
});

test("isGenericMessage allows specific English messages", () => {
  expect(isGenericMessage("feat: add login form with validation")).toBe(false);
  expect(isGenericMessage("fix: resolve null pointer in auth")).toBe(false);
});
```

2. **`cleanCommitOutput` pass-through + multi-layer scenarios**:
```typescript
test("cleanCommitOutput passes through clean messages unchanged", () => {
  expect(cleanCommitOutput("feat: add login form")).toBe("feat: add login form");
});

test("cleanCommitOutput handles nested wrappers (prefix in fences)", () => {
  const input = "Sure! Here is the commit message:\n```\nfeat: add login\n```";
  expect(cleanCommitOutput(input)).toBe("feat: add login");
});

test("cleanCommitOutput falls back to first line when no CC found", () => {
  expect(cleanCommitOutput("This is just a chat message\nwith multiple lines"))
    .toBe("This is just a chat message");
});
```

3. **`specificityScore` smoke test**:
```typescript
test("specificityScore ranks specific messages higher than generic ones", () => {
  const generic = specificityScore("chore: update files");
  const specific = specificityScore("feat: implement JWT authentication for API");
  expect(specific).toBeGreaterThan(generic);
});
```

4. **`isValidCommitSubject` English markers** (if P2-2 is implemented):
```typescript
test("isValidCommitSubject rejects English conversational markers", () => {
  expect(isValidCommitSubject("can you add login", "en")).toBe(false);
  expect(isValidCommitSubject("please fix the bug", "en")).toBe(false);
  expect(isValidCommitSubject("I'd like you to refactor auth", "en")).toBe(false);
});

test("isValidCommitSubject allows specific English subjects", () => {
  expect(isValidCommitSubject("add login form", "en")).toBe(true);
  expect(isValidCommitSubject("fix null pointer in auth", "en")).toBe(true);
});
```

**Changes:** ~250 lines (test file), ~5 lines (package.json), 1 line (tsconfig.json). No source code changes.

---

## P2-4: Defense-in-depth first-line extraction in `sanitizeCommitMessage`

**Severity:** Low
**Source:** Prompt-engineering review Issue #7, plan-risks review Section 6
**File:** `src/core/commit-message.ts`

### Problem

`sanitizeCommitMessage` uses the regex `/^(\w+)(\([^)]+\))?(!)?:\s*(.+)$/` **without** the `m` (multiline) flag. If a multi-line string is ever passed directly (bypassing `cleanCommitOutput`), the regex fails to match and the colon-fallback path produces garbage.

Currently safe because:
- `auto-commit-message.ts` always calls `cleanCommitOutput` before `sanitizeCommitMessage`
- `diff-analyzer.ts` has its own `parseHunks` cleanup

But future callers may not have this protection. A one-line defense costs nothing and prevents a class of bugs.

### Fix

Add first-line extraction at the top of `sanitizeCommitMessage`:

```typescript
export function sanitizeCommitMessage(
  message: string,
  files?: string[],
): string {
  // Defense-in-depth: take only the first non-empty line.
  // Multi-line input should have been cleaned by callers (cleanCommitOutput,
  // parseHunks), but this guards against future callers that forget.
  const firstLine = message
    .split("\n")
    .find((l) => l.trim().length > 0)
    ?.trim();
  let sanitized = firstLine ?? message.trim();
  // ... rest of function unchanged
```

**Changes:** ~5 lines (wrap existing `.trim()` in first-line extraction).

---

## Files Changed

| File | P2 Item | Changes |
|------|---------|---------|
| `src/core/auto-commit-message.ts` | P2-1, P2-2 | ~25 lines (import + constant + function body) |
| `src/core/diff-analyzer.ts` | P2-1 | 1 line (export existing function) |
| `src/core/commit-message.ts` | P2-4 | ~4 lines |
| `src/core/__tests__/auto-commit-message.test.ts` (new) | P2-3 | ~250 lines |
| `package.json` | P2-3 | ~5 lines (test script + tsx devDep) |
| `tsconfig.json` | P2-3 | 1 line (exclude tests) |

## Risks

| Risk | Mitigation |
|------|-----------|
| `truncateDiffAtNewline` may return empty string if `\n` not found before maxChars | Reuses existing `truncateDiff` from diff-analyzer.ts which has the same fallback to `slice` |
| English conversational markers may false-positive | `add+article` pattern removed after review. Remaining patterns (`can you`, `please`, `I'd like`, `let's`) are anchored at `^` and don't false-positive on legitimate commit subjects |
| Test framework choice may add unwanted dependency | `node:test` has zero dependencies and is built into Node 18+ |
| `sanitizeCommitMessage` first-line extraction breaks callers expecting multi-line | No caller passes multi-line input intentionally. The change is semantically neutral for single-line input |

## Validation

1. **P2-1**: Verify diff truncation at newline boundary with a diff containing `@@` headers
2. **P2-2**: Verify `isValidCommitSubject("can you add login", "en")` returns `false`
3. **P2-3**: Run `node --test src/core/__tests__/` and verify all pass
4. **P2-4**: Verify `sanitizeCommitMessage("feat: hello\n\ngoodbye")` returns `feat: hello`
