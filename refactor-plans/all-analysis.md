# pi-git Refactoring Analysis

**Total lines: 2,814** across **17 source files** in `src/`

---

## 1. Code Smells Per File

### `src/core/diff-analyzer.ts` (422 lines) — ⚠️ LARGEST FILE, HIGHEST SMELL DENSITY

| Smell | Location (lines) | Detail |
|-------|-------------------|--------|
| **God Object** | entire file | Mixes AI invocation, JSON/Regex hunk parsing (4-layer repair), diff batching, file splitting, stat parsing, prompt construction — all in one module. Should be at least 3 modules: `hunk-parser.ts`, `ai-analyzer.ts`, `diff-util.ts`. |
| **Deep nesting** | `parseHunks()` (L83–117) | 4-layer fallback chain with `if/else if/else` — each layer doubles as a side-effect (`diagIncr`). Deeply coupled to diagnostics. |
| **Mixed abstraction levels** | `analyzeDiff()` (L254–309) | Orchestrates batching logic, progress updates via `footerManager`, error swallowing, and fallback — all inline in the main export. |
| **Duplicated diff-split logic** | `splitDiffByFile()` (L350–376) vs `parseDiffStats()` (L381–419) | Both iterate the diff line-by-line parsing `diff --git` headers using nearly identical regex/code. |
| **Magic numbers** | L26–31 | `MAX_DIFF_BYTES = 30_000`, `FILES_PER_BATCH = 8`, `MAX_OUTPUT_TOKENS = 1024` — reasonable but untestable as module-level constants. |
| **Unused export** | `parseDiffStats()` (L381) | Defined but never imported by any other file (dead code). |
| **Side effects in pure functions** | `parseHunks()` (L83) | Calls `diagIncr()` at every layer — diagnostic counters make the function impure and harder to test. |

### `src/core/auto-commit-message.ts` (395 lines) — ⚠️ 2ND LARGEST

| Smell | Location | Detail |
|-------|----------|--------|
| **God Object** | entire file | Message generation, heuristic specificity scoring, Japanese-language keyword extraction, AI-based candidate comparison, truncation, text extraction — all in one file. |
| **Japanese string matching** | L80–89, L62–67 | `userMessageToCandidate()` and `specificityScore()` hardcode Japanese keywords (`修正`, `追加`, `削除`). These are effectively i18n logic leaking into core logic. |
| **Complex heuristic threshold** | `refineMessageIfGeneric()` L180–184 | `if (userScore > genScore + 5)` — magic threshold +5 with no explanation or configurability. |
| **Duplicated AI call pattern** | L224–247 vs `diff-analyzer.ts` L240–258 | Both construct `Context`, call `completeSimple`, extract text from `result.content`, handle errors the same way. |
| **Duplicated truncation** | `truncate()` L32–39 vs `truncateDiff()` in diff-analyzer L136–142 | Nearly identical: check length, substring, find last break character. |
| **Regex-based type inference** | `userMessageToCandidate()` L70–81 | Hardcoded Japanese/English keyword matching for Conventional Commit type inference — fragile to new languages. |
| **`isGenericMessage()` patterns** (L47–53) | Hardcoded regex array | `GENERIC_MESSAGE_PATTERNS` is a static set of regexes. Adding patterns requires code changes. Could be configurable or data-driven. |

### `src/commands/config.ts` (269 lines) — ⚠️ 3RD LARGEST, COMPLEX COMMAND

| Smell | Location | Detail |
|-------|----------|--------|
| **Long function** | `handleConfig()` L85–269 (184 lines) | Single function handles --global, --list, --show-origin, --keys, --models, --init, --help, get, set — all in one giant switch-style linear flow. |
| **Manual flag parsing** | L105–120 | Loops through tokens with `if/else if` chains instead of a declarative flag definition. Adding a new flag requires touching 4 places. |
| **Giant conditional block** | L121–262 | The "if help... else if init... else if keys... else if models... else if list... else if positional..." chain is brittle. |
| **Duplicated save path logic** | L235–260 | "Save to local vs global" logic is duplicated: checks `getLocalSettingsPath`, then `existsSync` on both paths, then different save calls. This mirrors logic in `auto-agg-commit.ts` L84–93. |

### `src/utils/settings.ts` (261 lines) — MODERATE SMELLS

| Smell | Location | Detail |
|-------|----------|--------|
| **File I/O + business logic** | L75–133 | `loadRaw()` mixes file reading, JSON parsing, TOML parsing, and legacy detection all in one function block. |
| **In-memory cache** | L142–158 | `Map<string, PiGitSettings>` cache has no TTL, no invalidation strategy beyond manual `clear()`. If cwd changes mid-session, stale data can persist. |
| **Legacy detection with side effect** | L115–131 | `loadRaw()` does a secondary `git rev-parse` + `existsSync` for legacy detection, emitting `console.warn` as a side effect during settings load. This mixes diagnostics with data loading. |
| **`initLocalSettings()` ambiguity** | L231–242 | Accepts `cwdOrPath` — either a cwd or a resolved path. The heuristic `cwdOrPath?.endsWith("pi-git.toml")` is fragile. |

### `src/utils/footer-manager.ts` (225 lines) — MODERATE SMELLS

| Smell | Location | Detail |
|-------|----------|--------|
| **Singleton with mutable state** | L209–218 (class) + L225 (instance) | `FooterManager` is a singleton class holding `pi`, `ui`, `cwd`, `running`, and `elapsedTimer`. Mutation-heavy; multiple callers share state. |
| **Timer lifecycle** | `startElapsedTimer()` / `stopElapsedTimer()` L200–212 | `setInterval` is managed manually with a nullable field. Risk of leaking timers if `clearRunning()` is not called (e.g., exceptions skip the `finally` block in callers). |
| **Redundant `setPhase` override** | `setPhase()` L128–138 | Updates 3 fields and calls `renderPhase()` — nearly identical in structure to `setCommitProgress()`. |
| **`lang` propagation** | `setRunning()` / `setPhase()` | `lang` is passed through 3 levels (`setRunning` → stored → `renderPhase` → `phaseStatusText`) but ultimately falls back to `getLanguage(this.cwd)` anyway. |

### `src/core/commit-message.ts` (157 lines) — LIGHT SMELLS

| Smell | Location | Detail |
|-------|----------|--------|
| **`inferTypeFromFiles()`** (L56–88) | Hardcoded regex rules | File-type → Conventional Commit type mapping is a chain of `if/return` statements. Adding a new file type requires changing this function. Could be a data-driven map. |
| **Duplicate fallback strings** | `generateFallbackMessage()` L127–135, `sanitizeCommitMessage()` L118 | `"chore: update files"` appears as a literal in multiple places instead of a shared constant. |
| **Unused `parseDiffStats()` import?** | N/A — actually in diff-analyzer.ts | See diff-analyzer dead code note. |

### `src/core/auto-commit.ts` (116 lines) — LIGHT SMELLS

| Smell | Location | Detail |
|-------|----------|--------|
| **Inline git status parsing** | L68–73 | Parses `git status --short` output to get changed files. This duplicates the pattern in `git.ts` `getStatus()`. |
| **Hardcoded error message patterns** | L87–95 | Exit code check with `resetStaging` + notify is a commit-result pattern that's duplicated in `agg-commit.ts` L136–155. |

### `src/commands/agg-commit.ts` (181 lines) — MODERATE SMELLS

| Smell | Location | Detail |
|-------|----------|--------|
| **Long function** | `handleAggCommit()` L26–177 (151 lines) | Single function does: arg parsing, help, lang override, pre-checks, diff collection, AI analysis, hunk processing, commit loop with progress, final summary, cleanup. |
| **Inline message map** | L64–68 | `{ not_git_repo: { text: ..., level: ... }, ... }` — these strings are NOT going through `t()` for i18n. Hardcoded English messages. |
| **Commit loop complexity** | L108–155 | 47-line for-loop with nested try/catch for `resetStaging`, `stageFiles`, `diff --cached --stat` check, `commit` — and failure counting. High cyclomatic complexity. |
| **Summary string building** | L157–171 | Manual array-building for summary notification with plural logic (`commit${committedCount > 1 ? "s" : ""}`) — no i18n. |

### `src/commands/auto-agg-commit.ts` (104 lines) — LIGHT SMELLS

| Smell | Location | Detail |
|-------|----------|--------|
| **Duplicate save path logic** | L84–93 | Same "localPath exists → saveLocal, else saveGlobal" pattern as `config.ts`. |
| **Unused `P` constant** | L22 | `const P = "[pi-git]"` defined but never used. |

### `src/core/git.ts` (160 lines) — CLEAN

| Smell | Location | Detail |
|-------|----------|--------|
| **`collectDiff()` complexity** (L101–146) | Stash/pop lifecycle | The stash→show→untracked diff→pop pattern is error-prone: if `pi.exec` for untracked diff throws before the `finally` block, `stash pop` still runs (good), but if `stash pop` itself fails, the user's working tree is left in a corrupted stash state with no recovery path. |

### `src/core/resolve-model.ts` (37 lines) — CLEAN

Well-focused single-responsibility module. No significant smells.

### `src/utils/lang.ts` (35 lines) — CLEAN

Well-implemented. The `as Record<string, Record<string, string>>` casts in `t()` suggest the `messages` type could be tighter.

### `src/utils/diagnostics.ts` (63 lines) — CLEAN

Well-focused. `diagIncr` and `diagSnapshot` are simple and correct. However, the tight coupling to `parseHunks()` and `auto-commit-message.ts` means the diagnostics module creates cross-cutting dependencies.

### `src/i18n/messages.ts` (216 lines) — CLEAN (data)

No functional smells. The `en` and `ja` catalogs are well-structured. Note: some prompts (in diff-analyzer and auto-commit-message) are HUGE — e.g., `diffAnalyzer.systemPrompt` is 750+ chars. Large prompts in i18n data are fine but note that they duplicate system instructions across languages.

### `src/types.ts` (24 lines) — CLEAN

Minimal, well-defined. No smells.

### `src/index.ts` (69 lines) — CLEAN

Simple entry point. No smells.

---

## 2. Top 5 Refactoring Proposals (Ranked P0 → P2)

### P0-1: Extract Shared AI-Call Infrastructure

**Affected files:** `src/core/diff-analyzer.ts` (L240–258), `src/core/auto-commit-message.ts` (L130–142, L224–247), `src/core/resolve-model.ts`

**Problem:** Both `diff-analyzer.ts` and `auto-commit-message.ts` independently:
- Resolve a model via `resolveModel(ctx)`
- Check auth with `ctx.modelRegistry.getApiKeyAndHeaders(model)`
- Build a `Context` with `{ systemPrompt, messages }`
- Call `completeSimple(model, context, { apiKey, headers, signal, reasoning, temperature, maxTokens })`
- Extract text from `result.content.filter(c => c.type === "text").map(c => c.text).join("")`
- Wrap in try/catch with fallback

This is 6 duplicated steps across 2 files, with subtle parameter differences (maxTokens, temperature).

**BEFORE (current pattern in diff-analyzer.ts L230–258):**
```typescript
const model = resolveModel(ctx);
if (!model) return fallbackFileBasedHunks(diff);

const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
if (!auth.ok) return fallbackFileBasedHunks(diff);

const context: Context = {
  systemPrompt: getSystemPrompt(lang),
  messages: [{ role: "user", content: buildPrompt(truncated, lang), timestamp: Date.now() }],
};

const result = await completeSimple(model, context, {
  apiKey: auth.apiKey,
  headers: auth.headers,
  signal: ctx.signal,
  reasoning: "minimal",
  temperature: 0,
  maxTokens: MAX_OUTPUT_TOKENS,
});

const text = result.content
  .filter((c): c is { type: "text"; text: string } => c.type === "text")
  .map((c) => c.text)
  .join("");
```

**AFTER:**
```typescript
// src/core/ai.ts (new file)
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./resolve-model.js";

export interface AICompletionOptions {
  systemPrompt: string;
  userMessage: string;
  lang?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: "minimal" | "medium" | "high";
}

export interface AICompletionResult {
  text: string;
  model: Model<Api>;
}

export async function aiComplete(
  ctx: ExtensionContext,
  options: AICompletionOptions,
): Promise<AICompletionResult | null> {
  const model = resolveModel(ctx);
  if (!model) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return null;

  const context: Context = {
    systemPrompt: options.systemPrompt,
    messages: [{
      role: "user",
      content: options.userMessage,
      timestamp: Date.now(),
    }],
  };

  const result = await completeSimple(model, context, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal: ctx.signal,
    reasoning: options.reasoning ?? "minimal",
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens ?? 1024,
  });

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  return { text, model };
}
```

Then `diff-analyzer.ts` becomes:
```typescript
const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(truncated, lang),
  maxTokens: MAX_OUTPUT_TOKENS,
  temperature: 0,
});
if (!result) return fallbackFileBasedHunks(diff);
const hunks = parseHunks(result.text);
```

And `auto-commit-message.ts` becomes:
```typescript
const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(userMessages, assistantMessages, changedFiles, lang),
});
if (!result) return sanitizeCommitMessage(t(lang, "core.applyChanges"), changedFiles);
```

**Estimated effort:** 3 hours
**Risk level:** Low (extracting identical logic, behavioral change is zero)
**Benefit:** Eliminates ~60 lines of duplicated code. Single point of change for AI call behavior (auth, error handling, text extraction). Future AI-related changes (retries, streaming, token counting) only touch one file.

---

### P0-2: Split `diff-analyzer.ts` into Focused Modules

**Affected files:** `src/core/diff-analyzer.ts` → 3 new files + reduced original

**Problem:** 422-line file mixes 5 distinct concerns:
1. Hunk JSON parsing with 4-layer repair (`parseHunks`, `tryParseHunkJSON`, `tryRegexExtractHunks`)
2. AI orchestration + batching (`analyzeDiff`, `callAIForDiff`, `splitDiffIntoBatches`)
3. Diff text utilities (`splitDiffByFile`, `truncateDiff`, `stripDiffNoise`, `countFilesInDiff`)
4. Prompt construction (`getSystemPrompt`, `buildPrompt`)
5. Hunk post-processing (`processHunks`, `fallbackFileBasedHunks`)
6. Dead code: `parseDiffStats()` — unused

**BEFORE/AFTER:**

Split into:

```
src/core/diff-analyzer.ts      → orchestrator only (~80 lines)
src/core/hunk-parser.ts         → parseHunks, tryParseHunkJSON, tryRegexExtractHunks (~60 lines)
src/core/diff-utils.ts          → splitDiffByFile, truncateDiff, stripDiffNoise, countFilesInDiff (~80 lines)
src/core/diff-prompts.ts        → getSystemPrompt, buildPrompt for diff analysis (~25 lines)
src/core/diff-batcher.ts        → splitDiffIntoBatches, AI batch loop logic (~70 lines)
```

Key BEFORE/AFTER change in `analyzeDiff()`:

**BEFORE (L254–309):** 55-line function orchestrating model resolution, auth, batching decision, batch loop with `footerManager.setCommitProgress`, and fallback — all inline.

**AFTER:** Thin orchestrator:
```typescript
export async function analyzeDiff(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  diff: string,
  langOverride?: string,
): Promise<Hunk[]> {
  const fileCount = countFilesInDiff(diff);
  const lang = langOverride ?? getLanguage(ctx.cwd);

  const result = await aiComplete(ctx, { /* ... */ });
  if (!result) return fallbackFileBasedHunks(diff);

  if (fileCount > FILES_PER_BATCH) {
    return batchAnalyzeDiff(ctx, diff, result.model, auth, lang);
  }
  return singleAnalyzeDiff(ctx, diff, result.model, auth, lang);
}
```

**Estimated effort:** 5 hours
**Risk level:** Medium (file splitting risks breaking imports; thorough test coverage needed)
**Benefit:** Each module is independently testable. `hunk-parser.ts` can be unit-tested with pure string inputs without AI. `diff-utils.ts` can be tested without mocking. Enables P0-3.

---

### P1-3: Extract Commit Loop Logic from `agg-commit.ts`

**Affected files:** `src/commands/agg-commit.ts`, `src/core/auto-commit.ts`

**Problem:** `handleAggCommit()` has a 47-line for-loop (L108–155) that handles:
- `resetStaging` with abort-on-failure semantics
- `stageFiles` per hunk
- `diff --cached --stat` verification
- `commit -m` execution
- Success/failure/skip counting
- Progress updates via `footerManager.setCommitProgress`

This is a general "commit hunks" operation that could be extracted and reused. Currently `auto-commit.ts` has a simpler version of the same pattern (single commit, no hunk loop).

**BEFORE (agg-commit.ts L108–155):**
```typescript
for (let i = 0; i < hunks.length; i++) {
  const hunk = hunks[i];
  await footerManager.setCommitProgress(i + 1, hunks.length);
  try { await resetStaging(pi, ctx.cwd); } catch {
    ctx.ui.notify("Failed to reset staging area, aborting batch", "error");
    failedCount++; break;
  }
  try { await stageFiles(pi, hunk.files, ctx.cwd); } catch {
    failedCount++; continue;
  }
  const { stdout: stagedDiff, code: diffCode } = await pi.exec(
    "git", ["diff", "--cached", "--stat"], { cwd: ctx.cwd });
  if (diffCode !== 0 || !stagedDiff.trim()) { skippedCount++; continue; }
  const { code: exitCode, stderr } = await pi.exec(
    "git", ["commit", "-m", hunk.message], { cwd: ctx.cwd });
  if (exitCode !== 0) { /* notify + failedCount++ */ continue; }
  committedCount++;
}
```

**AFTER:** Extract to `src/core/hunk-committer.ts`:
```typescript
export interface CommitHunksResult {
  committed: number;
  skipped: number;
  failed: number;
}

export async function commitHunks(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  hunks: Hunk[],
  onProgress?: (current: number, total: number) => Promise<void>,
): Promise<CommitHunksResult> {
  let committed = 0, skipped = 0, failed = 0;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    await onProgress?.(i + 1, hunks.length);

    // Reset staging
    try { await resetStaging(pi, ctx.cwd); } catch {
      failed++; break; // abort batch on reset failure
    }

    // Stage files
    try { await stageFiles(pi, hunk.files, ctx.cwd); } catch {
      failed++; continue;
    }

    // Verify staged content
    const { stdout: stagedDiff, code: diffCode } = await pi.exec(
      "git", ["diff", "--cached", "--stat"], { cwd: ctx.cwd }
    );
    if (diffCode !== 0 || !stagedDiff.trim()) { skipped++; continue; }

    // Commit
    const { code: exitCode, stderr } = await pi.exec(
      "git", ["commit", "-m", hunk.message], { cwd: ctx.cwd }
    );
    if (exitCode !== 0) { ctx.ui.notify(`Commit failed: ${stderr}`, "warning"); failed++; continue; }

    committed++;
  }
  return { committed, skipped, failed };
}
```

Then `agg-commit.ts` becomes:
```typescript
const result = await commitHunks(pi, ctx, hunks, async (i, total) => {
  await footerManager.setCommitProgress(i, total);
});
// ... summary notification (extracted to a shared formatting function)
```

**Estimated effort:** 2 hours
**Risk level:** Low (pure extraction, behavior unchanged)
**Benefit:** 47-line loop becomes a 3-line call. `commitHunks` can be unit-tested. `auto-commit.ts` could potentially reuse it (though it's a single-commit case today).

---

### P2-4: Unify i18n Coverage in `agg-commit.ts`

**Affected files:** `src/commands/agg-commit.ts`, `src/i18n/messages.ts`

**Problem:** `handleAggCommit()` contains hardcoded English strings that bypass the i18n system:
- L64–68: Pre-check messages (`"Not a git repository"`, `"Merge conflicts detected..."`, `"No changes to commit"`)
- L91: `"Failed to stash changes"`
- L100: `"No hunks found to commit"`
- L113: `"Failed to reset staging area, aborting batch"`
- L140: `` `Commit failed for "${hunk.message}" (exit code ${exitCode}).${detail}` ``
- L157–171: Summary string building with English plural logic

**BEFORE (L64–68):**
```typescript
const messages: Record<string, { text: string; level: "warning" | "info" | "error" }> = {
  not_git_repo: { text: "Not a git repository", level: "warning" },
  merge_conflict: { text: "Merge conflicts detected. Resolve conflicts before committing.", level: "error" },
  no_changes: { text: "No changes to commit", level: "info" },
};
```

**AFTER:**
Add keys to `messages.ts`:
```typescript
// en
"aggCommit.notGitRepo": "Not a git repository",
"aggCommit.mergeConflict": "Merge conflicts detected. Resolve conflicts before committing.",
"aggCommit.noChanges": "No changes to commit",
"aggCommit.failedStash": "Failed to stash changes",
"aggCommit.noHunks": "No hunks found to commit",
"aggCommit.stagingResetFailed": "Failed to reset staging area, aborting batch",
"aggCommit.commitFailed": 'Commit failed for "{message}" (exit code {exitCode})',
"aggCommit.summary": "Created {count} commit(s), {skipped} skipped, {failed} failed",

// ja
"aggCommit.notGitRepo": "Gitリポジトリではありません",
"aggCommit.mergeConflict": "マージコンフリクトが検出されました。解決してからコミットしてください。",
// ... etc
```

Then `agg-commit.ts`:
```typescript
const messages: Record<string, { key: MessageKey; level: "warning" | "info" | "error" }> = {
  not_git_repo: { key: "aggCommit.notGitRepo", level: "warning" },
  // ...
};
const entry = messages[preCheck];
ctx.ui.notify(t(runLang, entry.key), entry.level);
```

**Estimated effort:** 1.5 hours
**Risk level:** Low (adding translations, no logic change)
**Benefit:** Full Japanese localization of the agg-commit command. Currently Japanese users get English error messages in the middle of an otherwise Japanese-localized flow.

---

### P2-5: Extract Footer Lifecycle as a Decorator/Wrapper

**Affected files:** `src/commands/agg-commit.ts`, `src/core/auto-commit.ts`, `src/utils/footer-manager.ts`

**Problem:** Every command that uses the footer manager follows this boilerplate:
```typescript
try {
  await footerManager.setRunning(command, phase, lang);
  // ... command logic with setPhase() calls ...
} finally {
  try { await resetStaging(...); } catch { /* ignore */ }
  await footerManager.clearRunning();
}
```

This pattern appears in `agg-commit.ts` (L55–177) and `auto-commit.ts` (L58–97). The `finally` blocks also include cleanup logic like `resetStaging` that's specific to each command.

**BEFORE (current pattern in both files):**
```typescript
if (footerManager.isRunning()) {
  ctx.ui.notify(t(lang, "aggCommit.alreadyRunning"), "warning");
  return;
}
try {
  await footerManager.setRunning("agg-commit", "prepare", runLang);
  // ... 100+ lines ...
} finally {
  try { await resetStaging(pi, ctx.cwd); } catch { /* ignore */ }
  await footerManager.clearRunning();
}
```

**AFTER:** Add a `withFooter` helper:
```typescript
// src/utils/footer-manager.ts (add)
export async function withFooter<T>(
  command: string,
  initialPhase: Phase,
  lang: string | undefined,
  fn: (setPhase: (phase: Phase) => Promise<void>) => Promise<T>,
): Promise<T> {
  if (footerManager.isRunning()) {
    throw new FooterBusyError();
  }
  await footerManager.setRunning(command, initialPhase, lang);
  try {
    return await fn(footerManager.setPhase.bind(footerManager));
  } finally {
    await footerManager.clearRunning();
  }
}
```

Then `agg-commit.ts`:
```typescript
try {
  const result = await withFooter("agg-commit", "prepare", runLang, async (setPhase) => {
    await setPhase("collectDiff");
    const diff = await collectDiff(pi, ctx.cwd);
    // ...
    await setPhase("commit");
    // ... commit loop ...
    return { committedCount, failedCount, skippedCount };
  });
  // summary notification
} catch (err) {
  if (err instanceof FooterBusyError) {
    ctx.ui.notify(t(runLang, "aggCommit.alreadyRunning"), "warning");
    return;
  }
  throw err;
} finally {
  try { await resetStaging(pi, ctx.cwd); } catch { /* ignore */ }
}
```

**Estimated effort:** 2 hours
**Risk level:** Medium (changes the control flow pattern in two command handlers)
**Benefit:** Eliminates duplicated try/finally boilerplate. Guarantees `clearRunning()` is always called. Makes it impossible to forget the cleanup.

---

## 3. Files Ranked by Refactoring Urgency

| Rank | File | Lines | Urgency | Reason |
|------|------|-------|---------|--------|
| 🔴 1 | `src/core/diff-analyzer.ts` | 422 | **P0** | God object; 5+ concerns; dead code; highest cyclomatic complexity; deepest nesting (4 layers). If any single file causes bugs, it's this one. |
| 🔴 2 | `src/core/auto-commit-message.ts` | 395 | **P0** | God object; duplicated AI call pattern; Japanese keywords in core logic; heuristic thresholds with no explanation. |
| 🟡 3 | `src/commands/agg-commit.ts` | 181 | **P1** | Long function; hardcoded English; commit loop should be extracted; tight coupling to footer manager. |
| 🟡 4 | `src/commands/config.ts` | 269 | **P1** | Giant conditional chain; manual flag parsing; duplicate save logic with auto-agg-commit.ts. |
| 🟡 5 | `src/utils/settings.ts` | 261 | **P1** | Mixed I/O + business logic; fragile `initLocalSettings` heuristic; no cache TTL. |
| 🟢 6 | `src/utils/footer-manager.ts` | 225 | **P2** | Singleton with mutable state; timer lifecycle risk; but well-isolated and functional. |
| 🟢 7 | `src/core/commit-message.ts` | 157 | **P2** | Hardcoded inference rules; but focused and testable. |
| 🟢 8 | `src/core/auto-commit.ts` | 116 | **P2** | Clean but duplicates commit-result logic. |
| 🟢 9 | `src/core/git.ts` | 160 | **P2** | Stash recovery risk is theoretical; clean otherwise. |
| ⬜ 10 | `src/i18n/messages.ts` | 216 | **Nice to have** | Data file; large but structurally sound. |
| ⬜ 11 | `src/commands/auto-agg-commit.ts` | 104 | **Nice to have** | Unused constant; duplicate save logic. |
| ⬜ 12 | `src/commands/diagnostics.ts` | 86 | **Nice to have** | Clean; single concern. |
| ⬜ 13 | `src/utils/diagnostics.ts` | 63 | **Nice to have** | Clean; but creates cross-cutting dependency. |
| ⬜ 14 | `src/core/resolve-model.ts` | 37 | **Low** | Well-designed. |
| ⬜ 15 | `src/utils/lang.ts` | 35 | **Low** | Clean; minor type improvement possible. |
| ⬜ 16 | `src/index.ts` | 69 | **Low** | Simple entry. |
| ⬜ 17 | `src/types.ts` | 24 | **Low** | Minimal. |

---

## 4. Cross-Cutting Concerns

### A. Duplicated AI Call Pattern (across 2 files)

Both `diff-analyzer.ts` (`callAIForDiff()`) and `auto-commit-message.ts` (`generateAutoCommitMessage()` and `refineMessageIfGeneric()`) independently implement:
```
resolveModel → getApiKeyAndHeaders → build Context → completeSimple → extract text → handle errors
```

**Proposal:** Extract to `src/core/ai.ts` as `aiComplete()` (see P0-1 above). Also affects the auth-fallback-to-null pattern.

### B. Duplicated "Save Local vs Global" Logic (across 2 files)

`config.ts` (L235–260) and `auto-agg-commit.ts` (L84–93) both:
1. Call `getLocalSettingsPath(ctx.cwd)`
2. Check if a local path exists
3. Choose `saveLocalSettings(...)` or `saveGlobalSettings(...)`

**Proposal:** Add a `saveSettings(key, value, cwd)` convenience function to `settings.ts` that encapsulates this decision.

### C. Hardcoded Japanese Strings in Core Logic

`auto-commit-message.ts` `userMessageToCandidate()` (L80–89) and `specificityScore()` (L62–67) hardcode Japanese keywords like `修正`, `追加`, `削除`, `追加`, etc. for type inference.

This means:
- Adding a third language requires touching `auto-commit-message.ts` (not just `messages.ts`)
- The keyword sets for `en` and `ja` are inconsistent (e.g., `"修正"` maps to `fix`, but `"fix"` also maps to `fix`)

**Proposal:** Extract keyword→type mappings to `messages.ts` as arrays:
```typescript
// messages.ts (add)
"autoCommitMsg.typeKeywords.fix": ["fix", "bug", "error", ...],
// ja:
"autoCommitMsg.typeKeywords.fix": ["修正", "fix", "バグ", "不具合", "エラー", "直", "訂正"],
```
Then `userMessageToCandidate` reads these from i18n and matches universally.

### D. Duplicated Truncation Logic (across 2 files)

`diff-analyzer.ts` `truncateDiff()` (L136–142) and `auto-commit-message.ts` `truncate()` (L32–39) both:
1. Check if text exceeds maxChars
2. Take a substring
3. Find last newline (diff) or last space (message)
4. Return truncated with `"..."`

**Proposal:** Single `truncateText(text, maxChars, breakChar?)` in `src/utils/text.ts`.

### E. Footer Status Boilerplate (across 2 files)

`agg-commit.ts` and `auto-commit.ts` both wrap their logic in:
```
footerManager.setRunning() → ...work... → footerManager.setPhase() → footerManager.clearRunning()
```
in try/finally blocks with identical structure.

**Proposal:** `withFooter()` wrapper (see P2-5 above).

### F. Diagnostic Counter Coupling

`parseHunks()` in `diff-analyzer.ts` calls `diagIncr(...)` at 5 points. The diagnostics module is a cross-cutting concern — removing diagnostics would require changing `parseHunks()` internals.

**Proposal:** Use an event-emitter or callback pattern:
```typescript
function parseHunks(text: string, onLayer?: (layer: string) => void): Hunk[] {
  // ...
  if (direct) { onLayer?.("parse_layer2"); return direct; }
}
```
Then `diagIncr` is called at the call site, not inside the pure function. This makes `parseHunks` testable without mocking diagnostics.

### G. Dead Code: `parseDiffStats()` in diff-analyzer.ts

`parseDiffStats()` (L381–419) is defined but never imported or called by any file. It parses addition/deletion stats from a diff. **Remove it** or move to `diff-utils.ts` if needed later.

---

## Summary of Recommended Actions

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| **P0** | Extract `aiComplete()` shared AI call function (P0-1) | 3h | Eliminates ~60 lines duplication; single point of change |
| **P0** | Split `diff-analyzer.ts` into 5 modules (P0-2) | 5h | Testability; reduces largest file from 422→~80 lines |
| **P1** | Extract commit loop from `agg-commit.ts` (P1-3) | 2h | Eliminates 47-line inline loop; reusable |
| **P1** | Unify i18n in `agg-commit.ts` (P2-4) | 1.5h | Full Japanese localization for agg-commit |
| **P2** | `withFooter()` wrapper for footer lifecycle (P2-5) | 2h | Eliminates duplicated try/finally boilerplate |
| **P2** | Extract shared `truncateText()` utility | 0.5h | DRY |
| **P2** | Extract `saveSettings()` convenience function | 0.5h | DRY |
| **P2** | Remove dead code (`parseDiffStats`) | 0.25h | Cleanup |
| **P2** | Keyword→type mappings to i18n | 1h | Enables third-language support |
| **Nice** | Decouple diagnostics from parseHunks via callbacks | 0.5h | Testability |
