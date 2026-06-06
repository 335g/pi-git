# Unhandled Promise Rejection Audit — pi-git

## Summary

Scanned all 12 `.ts` files under `src/`. Found **3 medium-severity issues** and **4 low-severity notes**. The `pi.on("agent_end")` and `pi.on("session_start")` handlers in `index.ts` are already wrapped in try/catch (introduced in a prior fix). However, the three `pi.registerCommand(...)` handlers lack their own error boundaries, and several async calls within those handlers are placed outside their try/finally blocks.

---

## Medium-severity issues

### ❶ `commands/agg-commit.ts` line 83 — `setRunning` outside try/finally

```ts
await footerManager.setRunning("agg-commit", "prepare", runLang);  // ← outside try

try {
    const preCheck = await ensureReadyToCommit(pi, ctx.cwd);
    // ...
} finally {
    await footerManager.clearRunning();
}
```

**Risk:** If `footerManager.setRunning()` rejects (e.g., `ctx.ui.setStatus()` throws), `clearRunning()` is never called. The footer manager's `running` flag stays set to `true`, blocking all future agg-commit or auto-commit invocations until the session restarts. The error also propagates to `pi.registerCommand`'s handler which has **no try/catch** (see ❺).

**Fix:** Move `setRunning` inside the `try` block, or add a separate try/catch around it that calls `clearRunning()` on failure.

---

### ❷ `core/auto-commit.ts` lines 42–63 — four async calls outside try/finally

```ts
await footerManager.refresh();                     // line 42
// ...
if (!(await isGitRepository(pi))) { return; }      // line 48
if (!(await hasChanges(pi))) { return; }           // line 52
// ...
await footerManager.setRunning("auto-commit", ...); // line 59  ← outside try

try {
    // commit logic
} finally {
    await footerManager.clearRunning();
}
```

**Risk:** If `setRunning()` (line 59) rejects, `clearRunning()` is never called, same stale-state problem as ❶. If `refresh()`, `isGitRepository()`, or `hasChanges()` throw, the error propagates uncaught out of `handleAutoCommit`.

**Mitigation:** The `agent_end` event handler in `index.ts` wraps `handleAutoCommit` in try/catch, so the Promise rejection *is* caught there. However, the stale footer state from a failed `setRunning` is not cleaned up.

**Fix:** Same pattern as ❶ — bring `setRunning` inside try, or add a guard try/catch for the pre-try async calls.

---

### ❸ `core/diff-analyzer.ts` line 300 — floating Promise (`void` on async call)

```ts
for (let i = 0; i < batches.length; i++) {
    void footerManager.setCommitProgress(i + 1, batches.length);  // ← floating
    try {
        const hunks = await callAIForDiff(model, auth, ctx, batches[i], lang);
```

**Risk:** `footerManager.setCommitProgress()` is declared `async` (returns `Promise<void>`). Using `void` on it means: if the returned Promise rejects (e.g., `renderPhase()` → `ctx.ui.setStatus()` throws), it becomes an **unhandled Promise rejection**. Node.js will emit an `UnhandledPromiseRejectionWarning`.

**Fix:** Either `await` the call (it runs synchronously inside, so no real perf cost), or change `setCommitProgress` to a non-async method since it only performs synchronous operations.

---

## Low-severity notes

### ❹ `core/git.ts` lines 134 — `finally` block can throw, shadowing original error

```ts
try {
    // stash show, diff HEAD stash@{0}^3
} finally {
    await pi.exec("git", ["stash", "pop"], { cwd });  // can throw
}
```

**Risk:** If `stash pop` fails (e.g., merge conflict restoring), the `finally`-thrown error **replaces** any original error from the `try` block. The user never sees the actual analysis failure — only a confusing stash-pop error.

**Fix:** Wrap `stash pop` in its own try/catch inside the `finally`, log the pop failure separately, and re-throw the original error if one exists.

---

### ❺ `index.ts` lines 23–38 — `pi.registerCommand` handlers lack try/catch

```ts
pi.registerCommand("git-agg-commit", {
    handler: async (args, ctx) => {
        await handleAggCommit(pi, ctx, args);  // no try/catch
    },
});
```

All three registered commands (`git-agg-commit`, `git-config`, `git-auto-agg-commit`) have async handlers with no try/catch wrapper. Whether this causes unhandled rejections depends entirely on whether the `pi.registerCommand` framework captures thrown errors internally.

**Fix:** Add try/catch to each handler to ensure errors are caught regardless of framework behavior, and to report errors to the user via `ctx.ui.notify`.

---

### ❻ `commands/auto-agg-commit.ts` line 108 — `refresh()` outside try/catch

```ts
saveLocalSettings(...);
// or saveGlobalSettings(...);

await footerManager.refresh();  // ← outside try, can throw

ctx.ui.notify(...);
```

**Risk:** `refresh()` calls `pi.exec("git", ...)` and `ui.setStatus(...)`, both of which can throw. If `refresh()` rejects after settings are saved, the user gets no feedback but the setting *was* persisted.

**Fix:** Wrap in try/catch or restructure so the notification still fires on error.

---

### ❼ `footer-manager.ts` — all methods declared `async` but perform only sync work

`setRunning`, `setPhase`, `setCommitProgress`, `clearRunning`, `refresh` are all declared `async` despite containing only synchronous operations (field assignments, `setInterval`, `setStatus`). This forces every caller to `await` or risk floating Promise rejections (as seen in ❸).

**Fix:** Remove `async` from methods that don't use `await` internally. Only `refresh()` legitimately needs `async` because it calls `pi.exec`.

---

## Files NOT flagged (correct patterns)

| File | Reason |
|------|--------|
| `index.ts` `pi.on("session_start")` (line 15) | Wrapped in try/catch |
| `index.ts` `pi.on("agent_end")` (line 43) | Wrapped in try/catch |
| `core/commit-message.ts` | Pure functions, no async I/O |
| `core/resolve-model.ts` | Sync-only, no I/O |
| `utils/lang.ts` | Pure utility, no I/O |
| `utils/settings.ts` | Sync I/O (`readFileSync`, `writeFileSync`, `execSync`), no Promise-based code |
| `core/auto-commit-message.ts` `generateAutoCommitMessage` | Has try/catch around all AI calls |
| `core/auto-commit-message.ts` `refineMessageIfGeneric` | Has try/catch around AI call |
| `commands/config.ts` save block (lines 238–273) | Has try/catch around save operations |

---

## Audit scope

- **Files scanned:** 12 `.ts` files under `src/`
- **Patterns checked:** `pi.on(...)`, `pi.registerCommand(...)`, `await` in async functions outside try/catch, `void` on async calls, floating `.then()` chains, `finally` blocks with `await`
- **Repo:** `/Users/335g/dev/other/pi-git`
- **Date:** 2026-06-06
