# P2 Plan Review: Small Model Commit Message Follow-ups

**Date:** 2026-06-12
**Reviewer:** Subagent (code-review)
**Plan:** `.pi/plans/p2-follow-ups.md`
**Sources inspected:** `auto-commit-message.ts`, `commit-message.ts`, `diff-analyzer.ts`, `package.json`, `tsconfig.json`

---

## Overall Assessment

The plan is structurally sound across all 4 items. No blockers were found. However, there is one high-severity correctness concern in P2-2 and several medium-severity design issues in P2-1, P2-3, and P2-4. All are fixable before or during implementation.

---

## Detailed Findings

### P2-1: Newline-boundary diff truncation

**Severity:** Medium (design)
**Correctness:** ✅ Correct

#### What's good
- The function logic is correct: `lastIndexOf("\n")` with fallback to hard `slice` handles all edge cases including no-newline-found and newline-at-position-zero (where `lastNewline > 0` is false, falling back to `slice`).
- The call site in `buildPrompt` (line ~309) is correctly identified: `diffSection = truncate(cleaned, MAX_DIFF_CHARS)`.

#### Issue: DRY violation — existing `truncateDiff` in `diff-analyzer.ts`

The plan acknowledges `diff-analyzer.ts` line 193 contains a structurally identical function:

```typescript
// diff-analyzer.ts:193-198
function truncateDiff(diff: string, maxBytes: number): string {
  if (diff.length <= maxBytes) return diff;
  const slice = diff.substring(0, maxBytes);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.substring(0, lastNewline) : slice;
}
```

This is functionally identical to the proposed `truncateDiffAtNewline`. The only difference is the parameter name (`maxBytes` → `maxChars`).

**Suggestion:** Export `truncateDiff` from `diff-analyzer.ts` and import it in `auto-commit-message.ts` instead of duplicating. This avoids divergence if one copy changes. The tradeoff is a cross-module dependency, but `auto-commit-message.ts` already imports from `diff-analyzer.ts`:

```typescript
// auto-commit-message.ts:17
import { stripDiffNoise } from "./diff-analyzer.js";
```

Adding `truncateDiff` to that import is a one-line change and eliminates code duplication entirely.

#### Edge case verification

| Input | `maxChars` | Expected behavior | Handled? |
|-------|-----------|-------------------|----------|
| `"a\nb\nc"` | `10` | Returns `"a\nb\nc"` (below limit) | ✅ |
| `"a\nb\nc"` | `3` | `slice="a\nb"`, lastNewline=1, returns `"a"` | ✅ |
| `"abc"` (no newline) | `2` | `lastNewline=-1`, returns `"ab"` (hard cut) | ✅ |
| `"\na"` (newline at 0) | `1` | `lastNewline=0`, `>0` is false, returns `"\n"` | ✅ |
| `""` (empty) | `100` | `length=0`, returns `""` | ✅ |

All edge cases are correctly handled.

---

### P2-2: English conversational markers

**Severity:** High (correctness — false-positive risk)
**Correctness:** ❌ Has a false-positive issue

#### What's good
- The `else` block restructuring correctly converts the current "always true for English" behavior into a guarded check.
- The intent (defense-in-depth against conversational English in commit subjects) is sound.
- The `/^(can|could|would|will)\s+you\s/i` and `/^please\s/i` patterns are correctly targeted — no legitimate commit subject starts with "can you" or "please".

#### Issue: `/^(add|fix|create|remove|update|change)\s+(a|an|the|some)\s/i` false-positives on legitimate descriptions

This pattern is anchored at `^` and matches common CC verbs followed by an article. However, many **legitimate commit subjects** have this exact shape when derived from user messages:

| User message (raw chat) | Candidate subject (after prefix strip) | Pattern match? | Correct? |
|--------------------------|---------------------------------------|----------------|----------|
| "fix a null pointer in auth" | `fix a null pointer in auth` | ✅ matches `^(fix)\s+(a)\s` | ❌ FALSE POSITIVE |
| "add a new login form" | `add a new login form` | ✅ matches `^(add)\s+(a)\s` | ❌ FALSE POSITIVE |
| "update the config for rate limiting" | `update the config for rate limiting` | ✅ matches `^(update)\s+(the)\s` | ❌ FALSE POSITIVE |
| "can you fix a null pointer" | `can you fix a null pointer` | ❌ no (but caught by `can you`) | ✅ caught elsewhere |
| "I'd like you to refactor auth" | `I'd like you to refactor auth` | ❌ no (but caught by `I'd like` pattern) | ✅ caught elsewhere |

The pattern is **too broad** because `add`, `fix`, `create`, `remove`, `update`, and `change` are legitimate commit verbs, and `a/an/the/some` often appear in specific descriptions.

**Mitigating factors (why this isn't a blocker):**
1. `isValidCommitSubject` is only called in `refineMessageIfGeneric` on the **user-candidate** path. If the candidate is rejected, we fall back to the AI-generated message — which is the safer default.
2. The user-candidate has already been processed by `userMessageToCandidate`, which strips conversational prefixes (`please`, `してください`, etc.) and infers a CC type. So the candidate represents the user's "best attempt" at a commit message.
3. The specificity comparison via `specificityScore` runs before `isValidCommitSubject` and can already select the better message.

**Suggestion:** Consider one of these approaches:
- **Option A (safer):** Narrow the pattern to explicitly conversational starts: `/^(can|could|would|will|please|i|we|let'?s)\s/i`. This covers the conversational modes without false-positives on descriptive subjects. Then add a separate check: `/^(add|fix|create|remove|update|change)\s+(a|an|the|some)\s.*[?]$/i` to catch "add a login form?" (questions).
- **Option B (pragmatic):** Keep the pattern as-is, but document the known false-positive risk and the mitigation (fallback to AI-generated message). The user-candidate is a heuristic best-effort anyway.
- **Option C (precise):** Use only the conversational markers plus `/[?!]$/` and the length check. Remove the `add+article` pattern entirely. The conversational markers (`can you`, `could you`, `please`, `I'd like`) already catch the most egregious chat patterns.

#### Additional edge: `[?!]$` check

The plan also adds `if (/[?!]$/.test(body)) return false;`. This is correct — a commit subject ending in `?` or `!` is almost certainly conversational. No false-positive risk.

#### Edge: `body.length < 3` check

The plan adds `if (body.length < 3) return false;`. This mirrors the Japanese check. Correct — no meaningful commit subject is 1-2 characters.

---

### P2-4: First-line extraction in `sanitizeCommitMessage`

**Severity:** Medium (design / correctness nuance)
**Correctness:** ✅ Correct, but with a design note

#### What's good
- The intent (defense-in-depth against future callers passing multi-line input) is valid.
- The current "safety" argument is correct: all existing callers (`auto-commit-message.ts` via `cleanCommitOutput`, `diff-analyzer.ts` via `sanitizeHunk`) pass single-line input.
- The fix is semantically neutral for single-line input.

#### Verification: multi-line input without the fix

The plan's validation test case: `sanitizeCommitMessage("feat: hello\n\ngoodbye")` → expected `feat: hello`.

**Without the fix (current code):**
1. `message.trim()` → `"feat: hello\n\ngoodbye"` (internal newlines preserved)
2. `isConventionalCommit("feat: hello\n\ngoodbye")`: regex `/^(\w+)(\([^)]+\))?(!)?:\s*(.+)$/` has **no `m` flag**.
   - `^` matches start. `.+` matches `hello` (`.` doesn't match `\n`). `$` expects end-of-string but finds `\n` → **FAIL**.
3. Falls to colon-fallback: `colonIndex = 4`, `possibleSubject = "hello\n\ngoodbye"` → `chore: hello\n\ngoodbye` (incorrect type, still multi-line).

The fix is genuinely needed to handle this case. ✅

#### Issue: Redundant `.trim()` calls

The plan's proposed code:

```typescript
const firstLine = message
    .split("\n")
    .map((l) => l.trim())  // trim #1
    .find((l) => l.length > 0);
let sanitized = (firstLine || message).trim();  // trim #2
```

`message.trim()` (#2) is redundant when `firstLine` is found (it was already trimmed inside `.map()`). A cleaner version:

```typescript
const firstLine = message.split("\n").map(l => l.trim()).find(l => l.length > 0);
let sanitized = firstLine || message.trim();
```

Or even simpler, since `.trim()` on an already-trimmed string is idempotent:

```typescript
const firstLine = message.split("\n").find(l => l.trim().length > 0)?.trim();
let sanitized = firstLine ?? message.trim();
```

This is a code-cleanliness issue, not a bug.

#### Current callers cross-check

| Caller | File:Line | Passes multi-line? | Safe without fix? |
|--------|-----------|-------------------|-------------------|
| `generateAutoCommitMessage` | `auto-commit-message.ts:525` | No — `cleanCommitOutput` produces single line | ✅ |
| `generateAutoCommitMessage` (fallback) | `auto-commit-message.ts:495,517,538` | No — `t("core.applyChanges")` is single line | ✅ |
| `sanitizeHunk` | `commit-message.ts:155` | No — hunk messages from AI are single-line | ✅ |

All callers are safe. The fix is purely defense-in-depth.

---

### P2-3: Unit tests

**Severity:** Medium (process)
**Correctness:** ✅ Good, with gaps

#### Test framework readiness

**`node:test` availability:** ✅ Confirmed. `tsconfig.json` targets `ES2022`, and `@types/node@^25.9.1` confirms Node 25+. `node:test` has been stable since Node 18.

**Current test infrastructure:** ❌ None. `package.json` scripts only have `build` and `prepublishOnly`. No test runner configured.

**Gap:** The plan does not address how to **run** the tests. `node:test` with TypeScript requires a loader. Add to `package.json`:

```json
"scripts": {
    "test": "node --import tsx --test src/**/*.test.ts",
    "build": "tsc",
    "prepublishOnly": "npm run build && npm test"
}
```

(`tsx` is a common zero-config TS loader; `ts-node` is another option. Either needs adding as a devDependency.)

**Build exclusion:** The `tsconfig.json` has `rootDir: "./src"` and `include: ["src/**/*.ts"]`. Test files in `src/core/__tests__/` would be included in the build. Two options:
- Add `"exclude": ["src/**/__tests__/**"]` to `tsconfig.json`
- Or place tests outside `src/` (e.g., `tests/` at project root)

The plan should address this to avoid test files in the published `dist/`.

#### Test case coverage analysis

**`isGenericMessage` — Covered:** ✅ Japanese generic patterns (`修正しました`, `変更を適用`, etc.)
**`isGenericMessage` — Covered:** ✅ Japanese specific messages (`ログインフォームを追加`, `nullチェックを追加`)
**`isGenericMessage` — Covered:** ✅ Compound word (`削除機能を追加` — 削除 is in a compound, not standalone)
**`isGenericMessage` — Missing:** ❌ English generic patterns — the function also rejects English patterns (`chore: apply changes`, `chore: update files`). These should be tested:

```typescript
test("isGenericMessage detects English generic patterns", () => {
  expect(isGenericMessage("chore: apply changes")).toBe(true);
  expect(isGenericMessage("chore: update files")).toBe(true);
  expect(isGenericMessage("chore: commit changes")).toBe(true);
  expect(isGenericMessage("fix: fix bug")).toBe(true);  // short generic (<12 chars would catch it, but regex covers too)
});

test("isGenericMessage allows specific English messages", () => {
  expect(isGenericMessage("feat: add login form with validation")).toBe(false);
  expect(isGenericMessage("fix: resolve null pointer in auth module")).toBe(false);
});
```

**`cleanCommitOutput` — Covered:** ✅ Fences, chat prefixes (EN+JA), backticks, first-CC-line, Japanese fence info strings
**`cleanCommitOutput` — Missing:** ❌ Multi-layer scenarios (e.g., chat prefix wrapped in fences):
```typescript
test("cleanCommitOutput handles nested wrappers", () => {
  const input = "Sure! Here is the commit message:\n```\nfeat: add login\n```";
  expect(cleanCommitOutput(input)).toBe("feat: add login");
});
```

**`cleanCommitOutput` — Missing:** ❌ Pass-through (clean message unchanged):
```typescript
test("cleanCommitOutput passes through clean messages", () => {
  expect(cleanCommitOutput("feat: add login form")).toBe("feat: add login form");
});
```

**`cleanCommitOutput` — Missing:** ❌ Only conversational text (fallback to first line):
```typescript
test("cleanCommitOutput falls back to first line when no CC found", () => {
  expect(cleanCommitOutput("This is just a chat message\nwith multiple lines"))
    .toBe("This is just a chat message");
});
```

**`specificityScore` — Not covered.** The plan lists it as HIGH priority but doesn't include test cases. At minimum, smoke-test that score ordering is sensible:
```typescript
test("specificityScore ranks specific messages higher than generic ones", () => {
  const generic = specificityScore("chore: update files");
  const specific = specificityScore("feat: implement JWT authentication for API");
  expect(specific).toBeGreaterThan(generic);
});
```

**`isValidCommitSubject` (P2-2) — Not covered.** If P2-2 English markers are added, tests should verify:
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

---

## Interaction Analysis: P0/P1 + P2

All P2 items integrate cleanly with existing P0/P1 code. Verified:

| P2 Item | Touch point | Conflict? | Notes |
|---------|------------|-----------|-------|
| P2-1 | `buildPrompt` line ~309 | None | Replaces one call; `truncate` still used for user/assistant text |
| P2-2 | `isValidCommitSubject` line 143 | None | Only adds `else` block; Japanese path unchanged |
| P2-3 | New file | None | Test-only, no source changes |
| P2-4 | `sanitizeCommitMessage` line 82 | None | Wrap-and-preserve pattern; all callers pass single-line input |

No regression risk from any of the 4 items.

---

## Priority Validation

The plan's severity ratings are reasonable:

| Item | Plan severity | Reviewer assessment | Notes |
|------|--------------|-------------------|-------|
| P2-1 | Low-Medium | ✅ Medium | DRY violation nudges it up |
| P2-2 | Low | ⚠️ High | False-positive risk on legitimate subjects |
| P2-3 | Medium (process) | ✅ Medium | Test gaps aside, infrastructure is the main hurdle |
| P2-4 | Low | ✅ Low | Straightforward defense-in-depth |

---

## Summary of Findings

### Blocker (0)
None.

### High (1)
- **P2-2: `/^(add|fix|create|remove|update|change)\s+(a|an|the|some)\s/i` false-positives.** This pattern matches legitimate commit descriptions like `fix a null pointer` or `add a new endpoint`. Mitigated by graceful fallback (reverts to AI-generated message), but the pattern should be narrowed or reconsidered. See suggestions in the findings above.

### Medium (4)
- **P2-1: DRY violation.** `truncateDiff` in `diff-analyzer.ts:193` is structurally identical to the proposed `truncateDiffAtNewline`. Consider exporting and reusing instead of duplicating.
- **P2-3: Missing test infrastructure plan.** The plan doesn't specify how to run TypeScript tests or handle build exclusion. Recommended: add `tsx` as devDependency, add `"test"` script, and exclude `__tests__/` from `tsconfig.json`.
- **P2-3: Test case gaps.** Missing: English generic pattern tests for `isGenericMessage`, multi-layer extraction tests for `cleanCommitOutput`, pass-through tests, and P2-2 English marker tests.
- **P2-4: Redundant `.trim()` in proposed code.** The `.trim()` inside `.map()` and the outer `.trim()` are redundant. Idempotent, so not a bug, but could be cleaner.

### Low (1)
- **P2-3: `specificityScore` tests missing from plan.** Listed as HIGH priority in the function table but has zero test cases proposed. A smoke test comparing scores of generic vs. specific messages would be quick to add and provides valuable regression protection.
