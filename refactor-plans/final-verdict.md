# Final Verdict: pi-git Refactoring Plan Review

**Review date:** 2026-06-07
**Reviewer:** code review subagent
**Documents reviewed:**
- `/refactor-plans/all-analysis.md`
- `src/core/diff-analyzer.ts` (422 lines)
- `src/core/auto-commit-message.ts` (395 lines)
- `src/commands/agg-commit.ts` (181 lines)
- `src/commands/config.ts` (269 lines)
- `src/utils/settings.ts` (261 lines)
- `src/utils/footer-manager.ts` (225 lines)
- `src/core/git.ts` (160 lines)
- `src/core/commit-message.ts` (157 lines)
- `src/commands/auto-agg-commit.ts` (104 lines)
- `src/types.ts` (24 lines)

---

## Overall Assessment

The analysis is **substantially accurate** and well-organized. The major findings (god objects, duplicated AI call pattern, hardcoded English strings, dead code, manual flag parsing) are all verified against the actual source. However, there are several small factual inaccuracies and the urgency of some proposals is overstated. The analysis also misses ~7 notable issues.

---

## Proposal-by-Proposal Verdict

### P0-1: Extract Shared AI-Call Infrastructure (`aiComplete()`)

**Accuracy:** ✅ Correct. The pattern `resolveModel → getApiKeyAndHeaders → build Context → completeSimple → extract text → handle errors` is duplicated verbatim in:
- `diff-analyzer.ts` `callAIForDiff()` (L230–258)
- `auto-commit-message.ts` `generateAutoCommitMessage()` (L345–375)
- `auto-commit-message.ts` `refineMessageIfGeneric()` (L224–247)

**Risk:** Low. Pure extraction, behavioral zero-change. The only subtlety: the two callers use different `maxTokens` values (1024, unlimited, 100) and different `temperature` values (0, default). The proposed `AICompletionOptions` interface already handles this.

**Verdict: DO NOW** — First thing to implement. This is the foundation for all other refactorings.

---

### P0-2: Split `diff-analyzer.ts` into Focused Modules

**Accuracy:** Mostly correct, but with inaccuracies:

1. **Overstated "deep nesting":** The analysis calls `parseHunks()` a "4-layer fallback chain with `if/else if/else`" and "deeply nested." In reality, `parseHunks()` uses sequential early-return, not nested conditionals. Each layer returns immediately on success. This is a clean, flat pattern — not a nesting smell.

2. **"5 diagIncr calls":** The analysis says `diagIncr` is called at 5 points inside `parseHunks`. Actual count: **4 calls** (lines 101, 108, 113, 116).

3. **`parseDiffStats` not an export:** The analysis calls it an "unused export." It is actually an **unexported dead internal function** — never called, never exported. The todos in `.pi/todos/` confirm the export was already removed.

4. **Over-aggressive split:** Proposing 5 modules (orchestrator, hunk-parser, diff-utils, diff-prompts, diff-batcher) for a 422-line file is overkill. A more pragmatic split: 2-3 modules (e.g., hunk-parser + diff-utils, keep the rest). The prompts file (25 lines) and batcher (70 lines) are too small to justify separate files.

**Risk:** Medium. File splitting risks broken imports; **there are zero test files in the repo** — no safety net. The `splitDiffByFile` → `splitDiffIntoBatches` dependency chain means the modules are tightly coupled; splitting them would create circular or awkward import patterns.

**Verdict: DO LATER** — After P0-1 is done, the file becomes less urgent. Reconsider the split scope: 2-3 modules is sufficient. Write tests before splitting.

---

### P1-3: Extract Commit Loop Logic from `agg-commit.ts`

**Accuracy:** ✅ Accurate. The 47-line for-loop (L108–155) is a self-contained commit engine. The extraction is clean and the `CommitHunksResult` interface is well-designed.

**Risk:** Low. Pure extraction. The `resetStaging` on failure breaks the batch (correct — matches current behavior). The proposed `onProgress` callback keeps footer coupling outside the extracted function.

**Verdict: DO NOW** — Implement after P0-1. The extracted `commitHunks()` is independently testable.

---

### P2-4: Unify i18n Coverage in `agg-commit.ts`

**Accuracy:** ✅ Accurate. The hardcoded English strings at L64–68, L91, L100, L113, L140, and L157–171 are real. The summary builder with `commit${committedCount > 1 ? "s" : ""}` is the most egregious — no i18n plural support at all.

**Minor note:** The analysis proposes adding i18n keys like `aggCommit.notGitRepo`, but these pre-check messages come from `ensureReadyToCommit()` in `git.ts` (which returns `"not_git_repo"` string codes). The i18n mapping is correctly applied at the command layer (agg-commit.ts), not in the git utility. This is the right separation.

**Risk:** Low. Adding translation keys to `messages.ts`; no logic change.

**Verdict: DO NOW** — Independent of other refactorings. Can be done in parallel.

---

### P2-5: Extract Footer Lifecycle as a Decorator/Wrapper

**Accuracy:** ✅ The duplicated try/finally pattern IS real across `agg-commit.ts` and `auto-commit.ts`. However:

1. **The proposed `withFooter` has a design problem:** It catches the "already running" case by throwing `FooterBusyError`, but the current code uses `ctx.ui.notify()` + `return`. This changes the error-handling model from "notify user and exit gracefully" to "throw an exception." The caller has to wrap in try/catch, which is arguably worse than the current inline check.

2. **`resetStaging` is command-specific:** The `withFooter` wrapper doesn't include `resetStaging` cleanup, which means the caller still needs a `finally` block. The boilerplate reduction is marginal.

3. **Timer lifecycle risk:** The analysis correctly identifies that `setInterval` can leak if exceptions skip `clearRunning()`. But `withFooter` doesn't fundamentally solve this — the interval is still managed by the singleton's mutable state.

**Verdict: DO LATER** — The current pattern works. The marginal benefit is small and the abstraction introduces new edge cases. Better to address this after the other refactorings, and perhaps solve the timer leak by using `setTimeout` chaining instead of `setInterval`.

---

## Cross-Cutting Concerns Assessment

| Concern | Accuracy | Action |
|---------|----------|--------|
| A. Duplicated AI call pattern | ✅ Correct | Covered by P0-1 |
| B. Duplicated "save local vs global" logic | ✅ Correct | Simple utility, low priority |
| C. Japanese strings in core logic | ⚠️ Partially wrong | See below |
| D. Duplicated truncation | ✅ Correct | Trivial utility |
| E. Footer status boilerplate | ✅ Correct | Covered by P2-5 |
| F. Diagnostic counter coupling | ✅ Correct | Nice to have, not urgent |
| G. Dead code `parseDiffStats` | ✅ Correct (but not exported) | Remove now |

### Correction on Concern C (Japanese strings in core logic):

The analysis claims `specificityScore()` at L62–67 hardcodes Japanese keywords. **This is wrong.** `specificityScore()` contains only English regex:
```typescript
const genericWords = /\b(change|update|modify|fix|apply|commit|files?|stuff|things?)\b/gi;
const concreteVerbs = /\b(add|implement|create|remove|refactor|extract|rename|...)\b/gi;
```
Japanese keywords exist only in `userMessageToCandidate()` (L80–89). The real issue is that `specificityScore()` is **English-only** — it cannot evaluate Japanese commit messages at all, making the heuristic score meaningless for Japanese users. The keyword→type mapping extraction proposed is still valid but should only target `userMessageToCandidate()`.

---

## Missed Opportunities (not in the analysis)

### M1. Zero test coverage
**There are no test files anywhere in the repository.** This is the number one risk for any refactoring, especially P0-1 and P0-2. Without tests, regressions are invisible. **Before any refactoring, write at least unit tests for the target extraction functions.** The `hunk-parser` functions (`tryParseHunkJSON`, `tryRegexExtractHunks`, `parseHunks`) are pure string-in/object-out and are trivially testable.

### M2. `fallbackFileBasedHunks()` is a third `diff --git` header parser
Three functions independently parse `diff --git a/... b/...` headers:
- `splitDiffByFile()` (L361–376)
- `parseDiffStats()` (L392–419) — dead code
- `fallbackFileBasedHunks()` (L122–136) — live, used as AI fallback

The analysis mentions duplication between the first two but misses the third. All three use nearly identical regex: `/diff --git a\/(.+?) b\/(.+?)$/`. Removing `parseDiffStats` leaves two copies.

### M3. `FileStats` type is coupled to dead code
`types.ts` defines `FileStats` which is only used by `parseDiffStats()` — dead code. Removing `parseDiffStats` makes `FileStats` dead too. The analysis doesn't flag this.

### M4. `footer-manager.ts` `refresh()` has hardcoded English
`refresh()` (L85–107) contains:
```typescript
this.ui.setStatus(STATUS_KEY, `auto-commit: ${onOff}`);
this.ui.setStatus(STATUS_KEY, `auto-commit: ${onOff} (${state})`);
```
These strings bypass i18n entirely. The analysis focuses on `agg-commit.ts` i18n but misses the footer base display.

### M5. `auto-commit-message.ts` has two different text extraction patterns
`extractTextContent()` (L272–282) and the inline `result.content.filter(...)` (L351–355, L240–248) both extract text from AI responses. The inline version uses type guards; `extractTextContent` uses loose checks. These should be unified — and will be, naturally, after P0-1 extracts the shared AI call.

### M6. `auto-agg-commit.ts` unused constant
`const P = "[pi-git]";` (L22) is defined but never referenced. Trivial cleanup.

### M7. `config.ts` save logic has `!globalExists && !localExists` branch
The analysis mentions duplicated save logic but misses that `config.ts` L235–260 has a special case: when neither global nor local settings exist, it calls `saveLocalSettings({ ...DEFAULT_SETTINGS, [key]: parsed }, ctx.cwd)`. This means the first `config set` initializes with defaults, but subsequent sets merge into existing settings. This behavior is not replicated in `auto-agg-commit.ts`, which just does `saveLocalSettings({ auto_agg_commit: next }, ctx.cwd)`. The discrepancy may be intentional (auto-agg-commit only sets one key) but it's worth documenting.

---

## Implementation Order (Recommended)

| Step | What | Effort | Depends On |
|------|------|--------|------------|
| 0 | Write unit tests for `parseHunks`, `sanitizeCommitMessage`, `splitDiffByFile` | 2h | nothing — prerequisite for safety |
| 1 | **P0-1:** Extract `aiComplete()` to `src/core/ai.ts` | 3h | Step 0 |
| 2 | Remove dead code: `parseDiffStats` + `FileStats` type + unused `P` constant | 0.5h | Step 0 |
| 3 | **P2-4:** i18n for `agg-commit.ts` + footer base display (M4) | 2h | nothing (parallel) |
| 4 | **P1-3:** Extract `commitHunks()` to `src/core/hunk-committer.ts` | 2h | Steps 0, 1 |
| 5 | Fix Concern C: extract keyword→type mappings to i18n | 1h | Step 3 |
| 6 | Extract `truncateText()` utility (Concern D) | 0.5h | nothing |
| 7 | Extract `saveSettings()` convenience (Concern B) | 0.5h | nothing |
| 8 | Decouple diagnostics from `parseHunks` via callbacks (Concern F) | 0.5h | Step 0 |
| 9 | **P0-2 (reduced):** Split `diff-analyzer.ts` into 2-3 modules | 3h | Steps 1, 2 |
| 10 | **P2-5 (revised):** Fix timer leak in `FooterManager`; consider `withFooter` | 1-2h | Step 4 |

---

## Summary

| Proposal | Verdict | Reason |
|----------|---------|--------|
| P0-1 (Shared AI call) | **DO NOW** | Foundation. No risk. Eliminates 60+ duplicated lines. |
| P0-2 (Split diff-analyzer) | **DO LATER** | Over-scoped (5 modules). Needs tests first. Still valuable but less urgent after P0-1. |
| P1-3 (Extract commit loop) | **DO NOW** | Clean extraction. Makes core logic testable. |
| P2-4 (i18n in agg-commit) | **DO NOW** | User-facing. Independent. Fast. |
| P2-5 (Footer wrapper) | **DO LATER** | Low marginal benefit. Design needs revision. |

**Critical prerequisite:** Write unit tests before any extraction. The codebase has zero tests and the refactoring plan provides no safety net.
