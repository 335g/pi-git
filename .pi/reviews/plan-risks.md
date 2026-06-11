# Plan Risk & Regression Review: Small Model Commit Message Fix

**Date:** 2026-06-11
**Reviewer:** review subagent (risk, regressions, edge cases)
**Sources inspected:** plan, 3 review reports, `auto-commit-message.ts`, `commit-message.ts`, `messages.ts`, `diff-analyzer.ts`

---

## 1. Regression Risk for Large Models (deepseek-v4-pro et al.)

### Findings

| Fix | Regression Risk | Evidence |
|-----|----------------|----------|
| **P0-1** `cleanCommitOutput` | **None.** Large models produce clean single-line output. `cleanCommitOutput` receives `"feat: add login form"`, finds no fences/prefixes, Layer 3 returns it verbatim. | `cleanCommitOutput` is a pure extraction function; idempotent on clean input. |
| **P0-2** maxTokens 1024→200 | **None.** A single CC message needs ~15-30 tokens. 200 is abundant even for verbose scoped messages like `feat(auth): add comprehensive form validation with error messages`. | Token counting: even worst-case CC message fits in ~40 tokens. |
| **P0-3** Japanese generic patterns | **None for large English-using models.** For large Japanese models, the patterns are conservative — they only match bare generic words with optional polite endings. A specific message like `feat: 削除機能を追加` does NOT match (the regex requires the *entire* body to be a generic word + optional ending; `機能を追加` after `削除` prevents the match). | Verified by regex analysis in Section 4 below. |
| **P0-4** Budget rebalance (diff 5000→3000, assistant 600→2500) | ⚠️ **Moderate risk.** Large models excel at parsing raw diffs; the assistant summary is supplementary. Reducing diff budget by 40% removes primary signal. For a complex commit with 20+ files, 3000 chars of cleaned diff (~50-80 lines) may omit later files entirely. | `auto-commit-message.ts:309` — diff budget is the largest single signal for large models. The plan acknowledges this as a risk and defers model-aware budgets to P2-1. |
| **P0-5** Newest-first budget consumption | **Neutral-to-positive.** Large models benefit from recent context too. No regression. | The change is directionally correct for all model sizes. |
| **P1-1** Examples in system prompt | **None.** Longer system prompt doesn't affect large-model quality. | Complexity concern: see Interaction section below. |
| **P1-2** specificityScore rebalance | **None.** Large models rarely trigger refinement (their messages are already specific). | `refineMessageIfGeneric` short-circuits at `isGenericMessage` check. |
| **P1-3** Skip AI comparison for cheap models | **None.** Pattern matching only affects models with `mini`/`flash`/`nano`/`lite`/`small`/`haiku` in ID. | `deepseek-v4-pro`, `claude-opus`, `gpt-4o` are not caught. |
| **P1-4** Last-wins tiebreaker | **None.** Large models output clean "A" or "B"; this path is never reached. | |

### Conclusion on large-model regression

**P0-4 is the only real regression vector.** Mitigation is weak (plan's risk table says "P2-1: model-aware budgets" which is deferred). For a more robust approach, the budget rebalance should be conditional on model capability (the `isCheapModel` heuristic from P1-3 could gate it):

```typescript
const isSmall = ctx.model?.id ? isCheapModel(ctx.model.id) : false;
const MAX_ASSISTANT_CHARS = isSmall ? 2500 : 600;
const MAX_DIFF_CHARS = isSmall ? 3000 : 5000;
```

This would eliminate the regression while still delivering the fix for small models.

---

## 2. `cleanCommitOutput` Edge Cases

### 2a: Multiple CC messages in output

**Scenario:** AI outputs several options:
```
Here are some options:

feat: add login form
fix: resolve validation bug
chore: update dependencies
```

**Trace through `cleanCommitOutput`:**
1. Trim → unchanged
2. No fences
3. Prefix patterns don't match `"Here are some options:"` (not in the prefix list)
4. Layer 3 finds first CC line: `feat: add login form` → returns it.

**Verdict:** ✅ Correct behavior — picks first CC message. The unrecognized prefix `"Here are some options:"` doesn't cause harm because Layer 3 bypasses it by looking for CC-format lines directly.

### 2b: Japanese markdown fence

**Scenario:** Output uses Japanese fence info string:
````
```コミットメッセージ
feat: ログインフォームを追加
```
````

**Trace:**
1. Fence regex: ````(?:\w*)?\s*\n?([\s\S]*?)\n?````
   - `(?:\w*)` matches zero (Japanese chars are not `\w`). `\s*` also zero (next char is `コ`, not whitespace). `\n?` zero (same reason).
   - Lazy capture `([\s\S]*?)` extends to capture `コミットメッセージ\nfeat: ログインフォームを追加`.
   - `\n?``` matches the closing fence.
   - Result: `コミットメッセージ\nfeat: ログインフォームを追加` (without the final newline consumed by `\n?`).
2. Prefix stripping: `/^(?:コミットメッセージ[:\s]*)/` matches `コミットメッセージ\n` (the `\n` is whitespace matched by `\s*`). Strips → `feat: ログインフォームを追加`.
3. Layer 3: finds CC line. ✅

**Also works for single-line variant:**
````
```コミットメッセージ feat: ログインフォームを追加```
````
Fence extraction returns `コミットメッセージ feat: ログインフォームを追加`, prefix `コミットメッセージ ` stripped → correct. ✅

**Verdict:** ✅ Robust. The fence regex handles non-ASCII info strings gracefully (the `(?:\w*)?` group simply matches zero).

### 2c: Valid CC message containing the word "message"

**Scenario:** Commit about a messaging feature:
```
feat: add message queue to notifications
```

**Trace:**
1. No fences.
2. Prefix pattern `/^(?:here\s+is\s+(?:the\s+)?(?:commit\s+)?message[:\s]*)/i` — requires `here\s+is` first. `feat:` doesn't match. Similarly, no other prefix pattern matches.
3. Layer 3: finds `feat: add message queue to notifications` as valid CC line. ✅

**Scenario:** The word "commit message" appears literally:
```
commit message: feat: add queue
```
(Bad AI output from a small model.)

**Trace:**
1. No fences.
2. Prefix pattern `/^(?:commit\s+message[:\s]*)/i` matches `commit message: ` → stripped to `feat: add queue`. ✅
3. Layer 3: finds clean CC line. ✅

**Verdict:** ✅ No false positive. The prefix patterns are anchored at `^` and structured enough to avoid accidental matching on CC-valid lines.

### 2d: Backtick-wrapped message in prose (uncovered edge case)

**Scenario:** AI outputs:
```
The commit message is: `feat: add message broker`
```

**Trace:**
1. No triple-backtick fences.
2. Prefix `/^(?:the\s+commit\s+message\s+(?:is|should\s+be)[:\s]*)/i` matches `The commit message is: ` → text becomes `` `feat: add message broker` ``.
3. Layer 3: The line is `` `feat: add message broker` ``. CC regex `/^(feat|fix|...)(\(.+?\))?!?:\s/` fails because `^` expects `feat` but finds `` ` ``.
4. Layer 4: returns `` `feat: add message broker` `` with backticks.

**Downstream impact:** `sanitizeCommitMessage` cannot parse `` `feat: add message broker` ``. `isConventionalCommit` fails (starts with backtick). Colon-path finds `:` at `message:` → `possibleSubject = " \`feat"`. Result: `chore: \`feat`. **Message is corrupted.**

**Severity:** Low — this requires a specific output pattern (single-backtick wrapping with preamble). Most chatty models use triple-backtick fences (handled by Layer 1) or colon-prefixed prose (handled by Layer 2). A mitigation would be to add backtick stripping to `cleanCommitOutput`:

```typescript
// Between Layer 2 and Layer 3:
text = text.replace(/^`|`$/g, "");  // strip wrapping backticks
```

### 2e: Unrecognized Japanese preamble (gap in prefix patterns)

**Scenario:** AI outputs Japanese chatter not covered by the plan's three JP patterns:
```
今回のコミット: feat: ログインを追加
```

**Trace:**
1. No fences.
2. Prefix patterns for Japanese (`提案するコミットメッセージ`, `コミットメッセージ`, `以下がコミットメッセージです`) don't match `今回のコミット`.
3. Layer 3: Line is `今回のコミット: feat: ログインを追加`. CC regex fails (line doesn't start with a CC type).
4. Layer 4: returns `今回のコミット: feat: ログインを追加`.

**Downstream:** `sanitizeCommitMessage` colon-path finds first colon in `今回のコミット` → `possibleSubject = "feat: ログインを追加"` → `buildMessage("chore", undefined, "feat: ログインを追加")` → **`chore: feat: ログインを追加`** — double-prefixed, wrong type.

**Severity:** Low-Medium. Additional JP prefix patterns would close this gap:
```typescript
/^(?:今回のコミット[:\s]*)/,
/^(?:以下のコミットメッセージを提案します[:\s]*)/,
/^(?:コミットメッセージを作成しました[:\s]*)/,
/^(?:はい[,、]\s*承知しました[。.]?\s*)/,
```

### 2f: Empty/whitespace-only input

**Trace:** `cleanCommitOutput("")` → `""`, `cleanCommitOutput("  \n\n  ")` → `""`. Both return empty string. Downstream `sanitizeCommitMessage("")` produces `"chore: update files"` via fallback. ✅ Safe.

### 2g: Empty fence with no content

**Scenario:** ```` ```\n\n``` ```` (empty code block).

**Trace:** Fence regex captures empty content. `text = "".trim()` → `""`. Returns `""`. Downstream sanitzation handles it. ✅ Safe.

---

## 3. Budget Rebalance Edge Cases

### 3a: Diff truncation loses critical context for large diffs

**Current:** 5000 chars of cleaned diff.
**After:** 3000 chars (~50-80 diff lines at 40-60 chars/line).

For a commit touching 20+ files, the diff is split into file-level diffs joined together. At 3000 chars, only the first few files' diffs survive truncation. If the most important change is in a later file, it's completely invisible to the AI.

**Mitigation:** The assistant response budget increases from 600 to 2500 — for small models, this compensates because the assistant summary already describes what was done. For large models, this is a net loss because they parse raw diffs better than assistant prose.

**Note:** `diff-analyzer.ts` uses 30,000 bytes (10× more) with batch-based processing and newline-boundary truncation. The auto-commit-message pipeline is much more constrained. A P2 follow-up (P2-1: newline-boundary truncation) is planned but doesn't address the capacity reduction.

### 3b: Short assistant response + short user request

**Scenario:** User says `"fix"`, assistant replies `"done"`.

Budget utilization:
- User budget: 1500 available, ~3 used → 1497 wasted
- Assistant budget: 2500 available, ~4 used → 2496 wasted
- Diff budget: 3000 available → used per diff size

The wasted budget is harmless — the prompt sections are just empty or "(none)". No regression. However, the `buildPrompt` template always includes the section headers (`=== USER REQUEST ===`, `=== ASSISTANT RESPONSE ===`, etc.) which add ~140 chars of framing with no content. This is minor overhead.

### 3c: Interaction with P1-1 (examples moved to system prompt)

After P1-1, the `{examples}` placeholder is removed from `buildPrompt` template. This saves ~300-500 chars in the user prompt, partially offsetting the structural overhead. But the plan says "Remove or simplify" — if examples are fully removed, the user prompt becomes more focused on the actual diff/context. This is a positive interaction.

### 3d: `truncate()` uses space-boundary, not newline-boundary (for diff section)

**Current:** `truncate(cleanedDiff, MAX_DIFF_CHARS)` — space-boundary cut.
**Risk:** Diff lines don't have "words" in the natural-language sense. A space-boundary cut can break in the middle of a diff line like `+   const x` or `@@ -1,5 +1,7 @@`, rendering it syntactically invalid. Small models already struggle with diffs; truncated-diff adds confusion.

**The plan acknowledges this as P2-1** ("Newline-boundary diff truncation — Align auto-commit-message's diff truncation with diff-analyzer's approach"). The fix is deferred, but it's a real issue that compounds with the diff budget reduction.

---

## 4. Japanese Generic Pattern False-Positive Analysis

### Test cases for the P0-3 patterns:

| Message | Expected | Matches? | Correct? |
|---------|----------|----------|----------|
| `feat: 削除機能を追加` (add delete feature) | Specific | ❌ No | ✅ The pattern requires the entire body to match. `削除` is in generic words, but `機能を追加` after it doesn't match the optional ending group. |
| `fix: 削除しました` (deleted) | Generic | ✅ Yes | ✅ `削除` + `しました` + end |
| `fix: バグを修正` (fix a bug) | Specific | ❌ No | ✅ `バグ` is not in the generic word list |
| `fix: 修正しました` (fixed it) | Generic | ✅ Yes | ✅ `修正` + `しました` |
| `feat: ログインフォームを追加` (add login form) | Specific | ❌ No | ✅ `ログインフォーム` is not in generic list |
| `chore: ファイルを更新` (update files) | Generic | ✅ Yes | ✅ Caught by secondary pattern `/^chore:\s*(ファイルを更新)...$/i` |
| `feat: 編集機能を追加` (add edit feature) | Specific | ❌ No | ✅ `編集` is in generic list, but `機能を追加` doesn't match optional group; full body doesn't match |
| `feat: 編集` (edit) | Generic | ✅ Yes (and `m.length < 12`) | ✅ Caught by length gate or pattern |
| `fix: エラーを修正しました` (fixed errors) | Borderline | ❌ No | ⚠️ `エラー` is not in generic list. This is somewhat generic but the pattern doesn't catch it. Low risk — `エラー` is more specific than `修正` alone. |
| `chore: 依存関係を更新` (update dependencies) | Specific | ❌ No | ✅ `依存関係` not in generic list |
| `docs: ドキュメントを更新しました` (updated docs) | Specific | ❌ No | ✅ `ドキュメント` not in generic list |
| `chore: 更新を反映` (reflect updates) | Generic | ✅ Yes | ✅ `更新` + `を反映` matches |
| `chore: 変更を適用しました` (applied changes) | Generic | ✅ Yes | ✅ `変更` + `を適用しました` and also second pattern `変更を適用` |

### Overlap with P1-2 concrete verbs

P1-2 adds `追加, 実装, 作成, 削除, 修正, 改善, 更新, 対応` as both generic-pattern triggers AND rewarded concrete verbs. This is intentional:
- When these words appear **alone** (with optional polite endings), they're generic → P0-3 correctly flags them.
- When they appear **in a longer phrase** (e.g., `削除機能を追加`), they're specific → P0-3 doesn't flag, and P1-2 rewards them with +2 each.

No conflict. ✅

### False positive risk verdict: **Low.** The patterns are conservative. They only match when the ENTIRE body is a single generic word plus optional polite ending. Any additional specificity (extra nouns, objects, technical terms) prevents the match.

---

## 5. `isCheapModel` Heuristic Robustness

### Patterns:
```typescript
const CHEAP_MODEL_PATTERNS = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];
```

### Models correctly caught:
| Model ID | Matching pattern |
|----------|-----------------|
| `gpt-5.4-mini` | `/mini/i` |
| `openai/gpt-5.4-mini` | `/mini/i` |
| `claude-3.5-haiku` | `/haiku/i` |
| `gemini-2.0-flash` | `/flash/i` |
| `gemini-nano` | `/nano/i` |
| `deepseek-coder-v2-lite` | `/lite/i` |
| `mistral-small` | `/small/i` |
| `gpt-4o-mini` | `/mini/i` |
| `ministral-8b` | `/mini/i` (correct — it's a small model) |
| `phi-3-mini` | `/mini/i` |

### Models NOT caught:
| Model ID | Risk |
|----------|------|
| `gpt-5.4` (non-mini) | Low — base model is capable |
| `claude-sonnet` | Correct — sonnet is capable |
| `gemma-2-9b` | Medium — 9B model might be weak but no pattern catches it |
| `gemma-2-27b` | Low — 27B is mid-size, likely capable |
| `phi-3-medium` | Low — medium variant should be capable |
| `llama-3.1-8b` | Medium — 8B model might be weak |
| `qwen-2.5-7b` | Medium — 7B model might be weak |
| `codestral` (22B) | Low |

### False positive risk:
`/mini/i` matches `minimal`, `minister`, `diminish`, etc. In practice, model IDs don't use these as substrings in unexpected ways. The only borderline case is `ministral` which IS a small model.

**Risk level:** Low-Medium. The coverage is reasonable for known cheap models. However:
1. Some small models (7B-9B parameter range) slip through without `mini`/`flash`/`nano`/`lite`/`small`/`haiku` in their name.
2. The consequence of a false negative (not catching a small model) is that AI comparison is still attempted — which may produce bad output, but the fallback to heuristic scoring already handles that case (the `result` is null/empty → `return generatedMessage`).

**The bigger blind spot:** Models like `gemma-2-9b` or `llama-3.1-8b` that are functionally "small" but don't have marketing names indicating it. Adding a pattern like `/\b\d{1,2}b\b/i` (1-2 digit billion parameters) could cover these, but would false-positive on things like `gpt-4-32b`. This is hard to solve without actual model metadata.

**Suggestion:** The `isCheapModel` heuristic is a reasonable first-pass. If model metadata (context window size, parameter count) becomes available from the AI SDK, that should replace the regex heuristic.

---

## 6. Reviewer #1 Issue #7 — `sanitizeCommitMessage` Multiline Fix

### The reviewer's recommendation:
Add first-line extraction inside `sanitizeCommitMessage` itself (in `commit-message.ts`).

### The plan's approach:
Add `cleanCommitOutput` in `auto-commit-message.ts`, called BEFORE `sanitizeCommitMessage`. `commit-message.ts` is left unchanged.

### Is this sufficient?

**For the auto-commit-message pipeline: YES.** `cleanCommitOutput` Layer 3 extracts the first CC-format line, or Layer 4 returns the first non-empty line. By the time `sanitizeCommitMessage` is called, the input is always single-line. The multiline regex issue (`/^(\w+)(\([^)]+\))?(!)?:\s*(.+)$/` without multiline flag) never triggers because the input is single-line.

**For other callers of `sanitizeCommitMessage`:**

| Caller | Location | Multiline risk? |
|--------|----------|----------------|
| `auto-commit-message.ts:399` | Main generation path | ✅ Mitigated by `cleanCommitOutput` |
| `auto-commit-message.ts:380,396,415` | Fallback paths | ❌ Not applicable — input is hardcoded single-line strings |
| `commit-message.ts:155` (`sanitizeHunk`) | Hunk message processing | ❌ Not applicable — hunk messages come from `diff-analyzer.ts` which has its own `parseHunks` cleanup |
| `commands/agg-commit.ts:269` | User-edited hunk messages | ⚠️ Low risk — user-edited messages are single-line in practice |

**Defense-in-depth gap:** If someone adds a new caller of `sanitizeCommitMessage` in the future that passes raw AI output, the multiline issue resurfaces. Adding a one-line `const firstLine = message.split("\n")[0].trim()` at the top of `sanitizeCommitMessage` would close this gap permanently.

**Assessed as: Sufficient for the current codebase. Not ideal for future-proofing.**

---

## 7. Interaction Between Fixes

### P0-1 (cleanCommitOutput) × P0-4 (budget rebalance)
**No negative interaction.** The budget rebalance changes what the AI sees in its prompt. `cleanCommitOutput` then processes whatever the AI returns. These are serial steps — the cleaner only affects post-processing.

### P0-1 × P0-5 (newest-first order)
**No negative interaction.** P0-5 changes the prompt's message order. The AI might produce slightly different output. `cleanCommitOutput` handles both old and new output formats identically.

### P0-2 (maxTokens) × P0-4 (budget rebalance)
**No negative interaction.** The 200 token limit caps output size. With better assistant context from P0-4, the AI might produce a more detailed message, but 200 tokens is far more than any CC message needs.

### P0-3 (JP generic patterns) × P1-2 (specificityScore rebalance)
**Positive synergy.** P0-3 catches more Japanese generic messages → triggers refinement more often. P1-2 ensures Japanese candidates get fair scoring in refinement. These work together.

### P0-3 × P1-3 (skip AI comparison)
**Positive synergy.** P0-3 triggers refinement for Japanese generic messages. P1-3 prevents the same weak model from being asked to judge its own output.

### P1-3 × P1-4 (vote parsing)
**Orthogonal.** If P1-3 applies (cheap model), P1-4 is never reached (AI comparison is skipped). If P1-3 doesn't apply (capable model), P1-4 improves tie-breaking. No conflict.

### P1-1 (examples in system prompt) × P0-2 (maxTokens)
**Possible mild negative interaction.** Moving examples into the system prompt increases the system prompt length by ~300-500 chars. With `maxTokens: 200` and the existing prompt template, the total token count increases. However, this doesn't matter for models with context windows ≥8K tokens (virtually all models in use). No practical impact.

### P0-4 × all other P0 fixes: combined prompt structure change
**The aggregate change** — different budget allocation + different message ordering + examples moved — produces a significantly different prompt than the current code. This is a **behavioral change for ALL models**, not just small ones. The plan's validation section acknowledges this and calls for regression testing with deepseek-v4-pro. **This is not a bug but a necessary testing burden.**

---

## 8. `userMessageToCandidate` Edge Cases After P0 Fixes

After P0 fixes, the refinement path triggers more often (especially for Japanese). Below are edge cases for `userMessageToCandidate` and `isValidCommitSubject`:

### 8a: Japanese te-form with multi-clause sentences

**Input:** `"ログインフォームのバリデーションを追加してください。エラーメッセージも表示するように"`
- Cleanup chain: `[。.！!？?]$` → doesn't match (ends with `に`). `してください$` → doesn't match (ends with `に`). `して$` → doesn't match.
- Result: the full long sentence with conversational markers (`してください`, `。`).
- `isValidCommitSubject` catches `してください` → rejected. ✅

**Verdict:** Safeguarded by `isValidCommitSubject`.

### 8b: Redundant type prefix

**Input:** `"fix the null pointer bug please"`
- Cleanup: strips `please` → `fix the null pointer bug`.
- Type inference: `fix` keyword matches → type `fix`.
- Result: `fix: fix the null pointer bug` — redundant `fix fix`.

**Severity:** Low. The redundancy is cosmetic. `sanitizeCommitMessage` would process this fine (the subject is `fix the null pointer bug`). The P2-2 fix (English conversational markers) would add patterns to detect this.

### 8c: Type inference chooses wrong type

**Input:** `"update the payment processing logic"` (a feature change)
- Type inference: `update` doesn't match `fix` patterns. Doesn't match `feat` patterns. `process` doesn't match. Falls to `chore`.
- Result: `chore: update the payment processing logic` — `chore` when it should be `feat`.
- But then: the AI-generated message (from the full diff + context) would likely have the correct type. In refinement, the AI comparison or heuristic scoring would pick the better message.

**Severity:** Low. The candidate is just a fallback; the AI-generated message is the primary.

### 8d: User message is exactly a generic Japanese phrase

**Input:** `"ファイルを更新"` (update files)
- Type: no match for fix/feat/docs/refactor/test → `chore`.
- Result: `chore: ファイルを更新`.
- P0-3 detects this as generic → triggers refinement.
- AI-generated message might also be `chore: ファイルを更新` (same).
- Heuristic comparison: tie → AI comparison (or skipped by P1-3) → keeps generated message.
- End result: generic message still committed.

**Verdict:** This is a fundamental limitation — if neither the user nor the AI provide specific information, refinement has nothing to work with. Not a regression. ✅

### 8e: English user message with conversational markers

**Input:** `"can you add a login form"`
- `isValidCommitSubject` for non-Japanese: always returns `true` (no English guards).
- Result: `feat: can you add a login form` — conversational.

**Severity:** Low (P2-2). Currently the user candidate passes validation but would score poorly in heuristic comparison (the word "can" is generic, the phrase is short). The AI-generated message would typically win the comparison. However, if both candidates are poor, this could sneak through.

### 8f: Very short user message after cleanup

**Input:** `"fix"` → `isValidCommitSubject("fix", "en")` → `true` (no English guards, body is 3 chars).
- Type: `fix` → `fix`.
- Result: `fix: fix`.
- Length check: `m.length < 12` (8 chars) → detected as generic by `isGenericMessage`.
- ✅ Caught by the generic detection gate.

### Summary on `userMessageToCandidate`:
The function produces reasonable candidates in most cases. The main gaps (English conversational markers, redundant prefixes) are noted as P2 items and are low-risk. The `isValidCommitSubject` gate + `isGenericMessage` gate provide two layers of defense against bad candidates.

---

## Summary of Findings

### Regression Risks
| Risk | Severity | Fix |
|------|----------|-----|
| P0-4 diff budget reduction harms large models | **Medium** | Gate budget rebalance on `isCheapModel`; keep original budgets for capable models |
| Combined prompt restructuring affects all models | **Low** | Testing burden only; the validation plan covers this |

### Edge Cases in `cleanCommitOutput`
| Edge Case | Severity | Status |
|-----------|----------|--------|
| Multiple CC messages in output | Low | ✅ Handled (picks first CC line) |
| Japanese markdown fences | Low | ✅ Handled (fence regex works with non-ASCII) |
| Valid "message" keyword in subject | None | ✅ No false positive |
| Backtick-wrapped message in prose | **Low-Medium** | ⚠️ Not handled — add backtick stripping |
| Unrecognized Japanese preamble (`今回のコミット:`) | **Low-Medium** | ⚠️ Not handled — add more JP prefix patterns |
| Empty/whitespace-only input | None | ✅ Safe (falls to sanitization default) |

### Budget Rebalance Edge Cases
| Edge Case | Severity | Status |
|-----------|----------|--------|
| Large diffs lose critical later-file context | **Medium** | ⚠️ Risk for large models; model-aware budgets would fix |
| Short conversation wastes budget | None | ✅ Harmless |
| Space-boundary diff truncation compounds with reduced budget | **Low** | Deferred to P2-1 |

### Japanese Pattern False Positives
| Risk | Assessment |
|------|-----------|
| Specific messages flagged as generic | **Low.** Patterns are conservative (require exact body match with only generic words + polite endings) |
| Borderline messages not flagged | **Low.** `fix: エラーを修正しました` is borderline but `エラー` adds specificity; acceptable miss |

### `isCheapModel` Heuristic
| Concern | Assessment |
|---------|-----------|
| False positives (capable models caught) | **Low.** No known model IDs where patterns match a capable model |
| False negatives (small models missed) | **Medium.** 7-9B models without `mini`/`small`/etc. in name are missed |
| `/mini/i` matching `minimal` etc. | **Very Low.** No practical model ID collisions |

### Reviewer #1 Issue #7 (sanitizeCommitMessage multiline)
| Assessment |
|-----------|
| **Sufficient for current codebase.** `cleanCommitOutput` eliminates multiline input before `sanitizeCommitMessage` is called. |
| **Not future-proof.** Adding a one-line first-line extraction in `sanitizeCommitMessage` would close the gap permanently. |

### Fix Interactions
| Assessment |
|-----------|
| All P0 and P1 fixes are **largely orthogonal** with no negative interactions. |
| The aggregate prompt structure change (P0-4 + P0-5 + P1-1) is a behavioral shift that **requires testing on both small and large models**, as the plan's validation section already notes. |

---

## Recommendations

1. **Gate P0-4 budget rebalance on `isCheapModel`** to eliminate the large-model regression. One-line conditional: `const isSmall = isCheapModel(ctx.model?.id ?? "");`.

2. **Add backtick stripping to `cleanCommitOutput`** (between Layer 2 and Layer 3): `text = text.replace(/^`|`$/g, "");`.

3. **Expand Japanese prefix patterns** to cover `今回のコミット`, `以下のコミットメッセージを提案します`, `作成しました` variants.

4. **Consider adding defense-in-depth first-line extraction** in `sanitizeCommitMessage` (one line: `sanitized = sanitized.split("\n")[0].trim();`). This is low-cost, high-safety.

5. **Validate `isCheapModel` against actual model IDs** from the AI SDK to ensure the regex patterns match the models that trigger the original issue (`gpt-5.4-mini` and similar).
