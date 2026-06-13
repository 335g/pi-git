# Phase 1 実装プラン: TurnLog + accumulate モード + /git-agg-commit 拡張

> **参照**: `docs/design/batch-commit-with-message-log.md` (v2)
> **Status**: v2 — レビューフィードバック反映済み

## 概要

Phase 1 では以下を実装する：

1. **TurnLog** — セッション中の会話ログを蓄積するインメモリストア
2. **accumulate モード** — `agent_end` ではコミットせず TurnLog 蓄積のみ行う新モード
3. **拡張 `/git-agg-commit`** — TurnLog を AI プロンプトに注入して高品質な Hunk 分割を実現
4. **共有ユーティリティ抽出** — `commitHunks`, `runReview`, `collectMessagesByRole`, `isGenericMessage` 等を共有モジュールに

---

## レビュー反映による修正点

| # | レビュー指摘 | 反映 |
|---|------------|------|
| B1 | `isGenericMessage` 循環 import | `commit-message.ts` に移動 |
| B2 | `turnLog.append()` 呼出し未定義 | Step 10: `handleAutoCommit()` 内でモード分岐前に呼出し |
| B3 | `SimpleMessage` export 漏れ | `message-utils.ts` に export |
| B4 | `--review` 責務不明確 | accumulate モードでは `handleAggCommit` → `batchCommit` に全委譲 |
| B5 | `runReview()` 未共有 | `review.ts` に抽出し `batch-committer.ts` から利用 |
| N2 | 通知 dedup 脆弱 | `warnNotified` フラグ方式に変更 |
| N3 | `setBatchStatus` の `batchWarnTurns` 未定義 | `getBatchWarnTurns(this.cwd)` から取得 |
| N7 | 命名衝突 `truncate` / `tailTruncate` / `truncateDiff` | `headTruncate` / `tailTruncate` に統一 |
| — | `tailTruncate` サロゲートペア安全性 | `Array.from()` 使用 |
| — | `stripConversationalMarkers` 検出/削除混同 | `userMessageToCandidate()` の削除パターンを流用 |
| — | `commitHunks` の `lang` パラメータ | optional `lang` 維持 |
| — | TurnLog シングルトン vs パラメータ渡し | `footerManager` 同様のモジュールシングルトンに統一 |
| — | TurnLog 両モードで蓄積 | `per_turn` でも `append()` 実行 |

---

## Step 1: `src/utils/message-utils.ts` — メッセージユーティリティ抽出

### 目的
`auto-commit-message.ts` の共有可能な関数を抽出する。

### 抽出する関数

```typescript
// src/utils/message-utils.ts

/** メッセージオブジェクトの型 */
export interface SimpleMessage {
  role: string;
  content: string | unknown;
}

/** Collect all messages of a given role, newest first */
export function collectMessagesByRole(
  messages: SimpleMessage[],
  role: string,
): string[] { /* auto-commit-message.ts から移動 */ }

/** Extract text content from message content (handles string | array) */
export function extractTextContent(content: string | unknown): string { /* auto-commit-message.ts から移動 */ }

/** Head-truncate text to maxChars */
export function headTruncate(text: string, maxChars: number): string { /* auto-commit-message.ts の truncate をリネーム */ }

/** Tail-truncate text to maxChars (surrogate-pair safe) */
export function tailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return "..." + chars.slice(-maxChars).join("");
}

/** Strip conversational markers from text (ja + en) */
export function stripConversationalMarkers(text: string, lang?: string): string {
  // userMessageToCandidate() の .replace() チェーンを流用
  let result = text
    .replace(/[。.！!？?]$/, "")
    .replace(/\bplease\b/gi, "")
    .replace(/「|」/g, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  
  if (lang === "ja" || !lang) {
    result = result
      .replace(/お願いします$/, "")
      .replace(/してください$/, "")
      .replace(/してほしい$/, "")
      .replace(/してもらえますか$/, "")
      .replace(/してくれますか$/, "")
      .replace(/して$/, "");
  }
  
  return result;
}
```

### 変更ファイル
- **新規**: `src/utils/message-utils.ts`
- **変更**: `src/core/auto-commit-message.ts` — import 先変更、重複定義削除、`truncate` → `headTruncate` リネーム

---

## Step 2: `src/core/turn-log.ts` — TurnLog クラス

### 目的
セッションスコープのインメモリ会話ログストア。`agent_end` で蓄積し、`/git-agg-commit` 実行時に AI プロンプトへ注入する。

### API
```typescript
class TurnLog {
  static readonly MAX_ENTRIES = 20;
  static readonly MAX_CHARS = 8_000;

  get turnCount(): number;
  get totalFilesChanged(): number;
  get warnNotified(): boolean;

  append(event: AgentEndEvent, changedFiles: string[]): void;
  formatForPrompt(): string;        // AI プロンプト用にシリアライズ。空なら ""
  clear(): void;
}
```

### 実装詳細
- `TurnEntry` 型: `{ index, userMessage, assistantExcerpt, filesChanged }`
- `filesChanged` は必須（`git diff --name-only` から取得）
- ユーザーメッセージ: `tailTruncate(stripConversationalMarkers(userMsg), 500)`
- アシスタント抜粋: `stripConversationalMarkers(assistantMsg).slice(0, 300)`
- `formatForPrompt()`:
  - エントリを newest-first で反復
  - `### Turn N` 形式でシリアライズ
  - 累積文字数が `MAX_CHARS` を超えたら停止
  - 空の場合は `""` を返す
- `warnNotified`: 一度通知したら `true`、`clear()` でリセット
- エントリ数が `MAX_ENTRIES` を超えたら古いものから削除

### 変更ファイル
- **新規**: `src/core/turn-log.ts`

---

## Step 3: `src/core/commit-hunks.ts` — commitHunks 抽出

### 目的
`agg-commit.ts` の private 関数 `commitHunks` を共有モジュールに抽出し、`batch-committer.ts` からも再利用可能にする。

### API
```typescript
export async function commitHunks(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  hunks: Hunk[],
  lang?: string,  // optional — defaults to getLanguage(ctx.cwd)
): Promise<{ committed: number; failed: number; skipped: number; aborted: number }>
```

### 抽出内容
- `commitHunks(pi, ctx, hunks, runLang)` 関数全体（`agg-commit.ts:116-186`）
- `runLang` は `lang ?? getLanguage(ctx.cwd)` で解決
- 依存: `resetStaging`, `stageFiles`（`git.ts`）, `footerManager.setCommitProgress()`（`footer-manager.ts`）, `t()`（`lang.ts`）

### 変更ファイル
- **新規**: `src/core/commit-hunks.ts`
- **変更**: `src/commands/agg-commit.ts` — `commitHunks` を import に変更

---

## Step 4: `src/core/diff-analyzer.ts` — analyzeDiff 拡張 + 汎用検出

### 4a. `analyzeDiff()` に `turnLogText?` パラメータ追加

```typescript
export async function analyzeDiff(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  diff: string,
  langOverride?: string,
  turnLogText?: string,  // NEW: optional
): Promise<Hunk[]>
```

- `turnLogText` が truthy なら `buildPromptWithContext()` を使用
- falsy なら既存の `buildPrompt()` を使用（後方互換）
- バッチ分割時の TurnLog 部分フィルタは **Phase 2 に延期**（全 TurnLog を全バッチに送る。MAX_CHARS=8000 制限で安全）

### 4b. `processHunks()` に汎用メッセージチェック追加

```typescript
// processHunks() 内
export function processHunks(hunks: Hunk[]): Hunk[] {
  const sanitized = hunks.map(sanitizeHunk);
  const seenFiles = new Set<string>();
  return sanitized
    .map((hunk) => {
      // NEW: check for generic messages
      if (isGenericMessage(hunk.message)) {
        return { ...hunk, message: generateFallbackMessage(hunk.files) };
      }
      return hunk;
    })
    .map((hunk) => ({
      ...hunk,
      files: hunk.files.filter((f) => {
        if (seenFiles.has(f)) return false;
        seenFiles.add(f);
        return true;
      }),
    }))
    .filter((hunk) => hunk.files.length > 0);
}
```

- `isGenericMessage`, `GENERIC_MESSAGE_PATTERNS` は **`src/core/commit-message.ts` に移動済み**
- `generateFallbackMessage` は既に `commit-message.ts` に存在
- 循環 import なし（`diff-analyzer.ts` → `commit-message.ts` ← `auto-commit-message.ts`）

### 4c. `buildPromptWithContext()` 追加（i18n ベース）

新規 i18n キー `diffAnalyzer.buildPromptWithContext`:
```
=== GIT DIFF (PRIMARY — this is what actually changed) ===
```diff
{diff}
```

=== CONVERSATION LOG (supplementary — use only to infer intent) ===
{turnLogText}

Split the diff above into logical hunks. Use the conversation log ONLY to
understand WHY changes were made, not to override the diff structure.
```

### 4d. システムプロンプト拡張

新規 i18n キー `diffAnalyzer.systemPromptWithContext`:
- 優先順位ルール（diff > co-location > TurnLog Files > TurnLog text）
- 汎用メッセージ禁止事項
- 「1 ターン ≠ 1 hunk」
- diff が常に優先

### 変更ファイル
- **変更**: `src/core/diff-analyzer.ts`
- **変更**: `src/core/commit-message.ts` — `isGenericMessage` + `GENERIC_MESSAGE_PATTERNS` をここに移動
- **変更**: `src/core/auto-commit-message.ts` — `isGenericMessage` / `GENERIC_MESSAGE_PATTERNS` の import 先変更
- **変更**: `src/i18n/messages.ts` — 新規キー追加

---

## Step 5: `src/core/review.ts` — `runReview` 抽出

### 目的
`agg-commit.ts` の private 関数 `runReview` を `review.ts` に抽出し、`batch-committer.ts` からも利用可能にする。

### API
```typescript
export async function runHunkReview(
  ctx: ExtensionCommandContext,
  hunks: Hunk[],
  diff: string,
  runLang: string,
): Promise<ReviewResult | null>
```

### 抽出内容
- `runReview()` 関数全体（`agg-commit.ts:55-85`）
- `findUnstagedFiles()` 補助関数も同時に抽出（または `review.ts` 内に private で配置）

### 変更ファイル
- **変更**: `src/core/review.ts` — `runHunkReview()` 追加
- **変更**: `src/commands/agg-commit.ts` — `runReview` を import に変更、`findUnstagedFiles` 削除

---

## Step 6: `src/i18n/messages.ts` — 新規 i18n キー

### 追加キー一覧

| キー | 用途 |
|------|------|
| `diffAnalyzer.systemPromptWithContext` | 拡張システムプロンプト（en/ja） |
| `diffAnalyzer.buildPromptWithContext` | diff + TurnLog テンプレート（en/ja） |
| `footer.autoCommit.accumulate` | Footer: `auto-commit: accumulate ({turns} turns) \| {files} files` |
| `footer.autoCommit.accumulateWarn` | Footer: `⚠ auto-commit: accumulate (...)` |
| `footer.autoCommit.accumulateCritical` | Footer: `!! auto-commit: accumulate (...) — run /git-agg-commit` |
| `config.keyDesc.auto_agg_commit_mode` | 設定説明 |
| `config.keyDesc.batch_warn_turns` | 設定説明 |
| `batchCommit.warnThreshold` | 蓄積警告: `{count} turns of uncommitted changes. Run /git-agg-commit to commit.` |
| `batchCommit.modeSwitchNotice` | モード切替通知 |

---

## Step 7: `src/utils/settings.ts` — 新規設定

### `PiGitSettings` に追加
```typescript
auto_agg_commit_mode?: "per_turn" | "accumulate";
batch_warn_turns?: number;  // non-negative integer (0 = disabled)
```

### `DEFAULT_SETTINGS`
```typescript
auto_agg_commit_mode: "per_turn",
batch_warn_turns: 5,
```

### コンビニエンスゲッター
```typescript
export function getAutoAggCommitMode(cwd?: string): "per_turn" | "accumulate" { ... }
export function getBatchWarnTurns(cwd?: string): number { ... }
```

---

## Step 8: `src/commands/config.ts` — 新規キーバリデーション

### `ValidKey` に追加
```typescript
| "auto_agg_commit_mode"
| "batch_warn_turns"
```

### `validateValue()` に追加
```typescript
case "auto_agg_commit_mode":
  if (value !== "per_turn" && value !== "accumulate") {
    throw new Error(`... Must be "per_turn" or "accumulate".`);
  }
  return value;

case "batch_warn_turns":
  // 0 = disabled, positive = threshold
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`... Must be a non-negative integer.`);
  }
  return num;
```

---

## Step 9: `src/utils/footer-manager.ts` — accumulate モード表示

### 追加メソッド
```typescript
setBatchStatus(turns: number, files: number): void {
  const warnTurns = getBatchWarnTurns(this.cwd);
  const key = warnTurns > 0 && turns >= warnTurns * 2
    ? "footer.autoCommit.accumulateCritical"
    : warnTurns > 0 && turns >= warnTurns
      ? "footer.autoCommit.accumulateWarn"
      : "footer.autoCommit.accumulate";

  this.ui.setStatus(STATUS_KEY, t(lang, key, {
    turns: String(turns),
    files: String(files),
  }));
}
```

- `refresh()` との競合防止のため、`accumulateStatus` フラグを追加。`refresh()` は accumulate モード中は上書きしない

---

## Step 10: `src/core/auto-commit.ts` — モード分岐 + TurnLog.append

### 変更内容

```typescript
export async function handleAutoCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: AgentEndEvent,
): Promise<void> {
  if (!ctx.hasUI) return;
  if (footerManager.isRunning()) return;

  const autoCommitEnabled = getAutoAggCommit(ctx.cwd);
  await footerManager.refresh();
  if (!autoCommitEnabled) return;
  if (!(await isGitRepository(pi))) return;
  if (!(await hasChanges(pi))) return;

  const lang = getLanguage(ctx.cwd);
  // ... existing: gather changedFiles from git status ...

  // ── NEW: Always append to TurnLog (both modes) ──
  const changedFiles = /* existing git status logic, moved before mode check */;
  turnLog.append(event, changedFiles);

  // ── Mode check ──
  const mode = getAutoAggCommitMode(ctx.cwd);
  if (mode === "accumulate") {
    // accumulate モード: TurnLog 蓄積のみ、コミットしない
    await footerManager.setBatchStatus(turnLog.turnCount, turnLog.totalFilesChanged);
    const warnTurns = getBatchWarnTurns(ctx.cwd);
    if (warnTurns > 0 && turnLog.turnCount >= warnTurns && !turnLog.warnNotified) {
      turnLog.warnNotified = true;
      ctx.ui.notify(t(lang, "batchCommit.warnThreshold", { count: String(turnLog.turnCount) }), "warning");
    }
    return;
  }

  // per_turn モード: 既存の即時コミットフロー
  // ... (existing confirmation + commit logic, unchanged) ...
}
```

### 変更ファイル
- **変更**: `src/core/auto-commit.ts`
- **変更**: `src/index.ts` — `turnLog` はモジュールシングルトンとして import されるため、シグネチャ変更不要

---

## Step 11: `src/core/batch-committer.ts` — バッチコミットフロー

### 目的
accumulate モードで `/git-agg-commit` から呼ばれる一括コミットフロー。

### API
```typescript
export async function batchCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  langOverride?: string,
): Promise<{ committed: number; failed: number; skipped: number; aborted: number }>
```

- `turnLog` はシングルトンとして import
- `isReview` はパラメータとして受け取る

### フロー
```
1. hasChanges() チェック
2. collectDiff() で diff 収集
3. turnLog.formatForPrompt() で TurnLog シリアライズ
4. analyzeDiff(pi, ctx, diff, lang, turnLogText || undefined) で Hunk 分割
5. processHunks() で後処理（汎用検出含む）
6. isReview なら runHunkReview() 表示
7. commitHunks() でシーケンシャルコミット
8. turnLog.clear() — コミット試行後に無条件でクリア
9. 結果返却
```

### 変更ファイル
- **新規**: `src/core/batch-committer.ts`

---

## Step 12: `src/commands/agg-commit.ts` — TurnLog 統合 + 委譲

### 変更内容

accumulate モードでは `batchCommit()` に全委譲：

```typescript
export async function handleAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  // ... existing: help, lang, running check ...

  const mode = getAutoAggCommitMode(ctx.cwd);
  const isReview = parseReviewFlag(args);

  // ... existing: preCheck, diff collection ...

  if (mode === "accumulate" && turnLog.turnCount > 0) {
    // accumulate モード: batchCommit に全委譲
    const result = await batchCommit(pi, ctx, runLang);
    // ... notify summary ...
    return;
  }

  // per_turn モード: 既存フロー（analyzeDiff → review → commitHunks）
  // ただし commitHunks と runReview は import 先が変わる
}
```

### 変更ファイル
- **変更**: `src/commands/agg-commit.ts`

---

## Step 13: `src/core/auto-commit-message.ts` — import 先変更

### 変更内容
- `collectMessagesByRole`, `extractTextContent`, `headTruncate` → `message-utils.js` から import
- `isGenericMessage`, `GENERIC_MESSAGE_PATTERNS` → `commit-message.js` から import
- 重複定義を削除

---

## Step 14: `src/index.ts` — TurnLog ライフサイクル統合

### 変更内容

```typescript
import { TurnLog } from "./core/turn-log.js";

// モジュールシングルトン（footerManager と同じパターン）
let turnLog: TurnLog | undefined;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (ctx.hasUI) {
        turnLog = new TurnLog();  // セッション開始時に初期化
        footerManager.initialize(pi, ctx.ui, ctx.cwd);
        await recoverOrphanedStashes(pi, ctx);
        await footerManager.refresh();
      }
    } catch { /* ignore */ }
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      if (!turnLog) return;  // guard
      await handleAutoCommit(pi, ctx, event as AgentEndEvent);
    } catch { /* ignore */ }
  });

  // コマンドハンドラは内部で turnLog を import して使用
}
```

### 変更ファイル
- **変更**: `src/index.ts`

---

## 実装順序（依存関係順）

| 順序 | Step | ファイル | 依存 |
|------|------|---------|------|
| 1 | Step 1 | `message-utils.ts` (新規) | なし |
| 2 | Step 13 | `auto-commit-message.ts` (変更) | Step 1 |
| 3 | Step 4d | `commit-message.ts` (変更) | なし（`isGenericMessage` 移動） |
| 4 | Step 2 | `turn-log.ts` (新規) | Step 1 |
| 5 | Step 3 | `commit-hunks.ts` (新規) | なし（git.ts, footer-manager.ts, lang.ts） |
| 6 | Step 5 | `review.ts` (変更) | なし |
| 7 | Step 4a-c | `diff-analyzer.ts` (変更) | Step 4d |
| 8 | Step 6 | `messages.ts` (変更) | なし |
| 9 | Step 7 | `settings.ts` (変更) | なし |
| 10 | Step 8 | `config.ts` (変更) | Step 7 |
| 11 | Step 9 | `footer-manager.ts` (変更) | Step 7 |
| 12 | Step 11 | `batch-committer.ts` (新規) | Step 2-6 |
| 13 | Step 10 | `auto-commit.ts` (変更) | Step 2, 9 |
| 14 | Step 12 | `agg-commit.ts` (変更) | Step 3, 5, 11 |
| 15 | Step 14 | `index.ts` (変更) | Step 2, 10, 12 |
