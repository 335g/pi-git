# Phase 1 実装プラン: TurnLog + accumulate モード + /git-agg-commit 拡張

> **参照**: `docs/design/batch-commit-with-message-log.md` (v2)

## 概要

Phase 1 では以下を実装する：

1. **TurnLog** — セッション中の会話ログを蓄積するインメモリストア
2. **accumulate モード** — `agent_end` ではコミットせず TurnLog 蓄積のみ行う新モード
3. **拡張 `/git-agg-commit`** — TurnLog を AI プロンプトに注入して高品質な Hunk 分割を実現
4. **共有ユーティリティ抽出** — `commitHunks`, `collectMessagesByRole` 等を共有モジュールに

---

## Step 1: `src/utils/message-utils.ts` — メッセージユーティリティ抽出

### 目的
`auto-commit-message.ts` の `collectMessagesByRole`, `extractTextContent` を共有モジュールに抽出し、TurnLog からも利用可能にする。

### 抽出する関数
| 関数 | 元の場所 | 新モジュール |
|------|---------|-------------|
| `collectMessagesByRole()` | `auto-commit-message.ts:392-406` | `message-utils.ts` |
| `extractTextContent()` | `auto-commit-message.ts:383-392` | `message-utils.ts` |
| `truncate()` (head) | `auto-commit-message.ts:24-29` | `message-utils.ts` |
| `tailTruncate()` | —（新規） | `message-utils.ts` |
| `stripConversationalMarkers()` | —（新規、`CONVERSATIONAL_MARKERS_JA` を流用） | `message-utils.ts` |

### 変更ファイル
- **新規**: `src/utils/message-utils.ts`
- **変更**: `src/core/auto-commit-message.ts` — import 先を変更、重複定義を削除

---

## Step 2: `src/core/turn-log.ts` — TurnLog クラス

### 目的
セッションスコープのインメモリ会話ログストア。`agent_end` で蓄積し、`/git-agg-commit` 実行時に AI プロンプトへ注入する。

### API
```typescript
class TurnLog {
  get turnCount(): number;
  get totalFilesChanged(): number;

  append(event: AgentEndEvent, changedFiles: string[]): void;
  formatForPrompt(): string;        // AI プロンプト用にシリアライズ。空なら ""
  clear(): void;
}
```

### 実装詳細
- `TurnEntry` 型: `{ index, userMessage, assistantExcerpt, filesChanged }`
- `MAX_ENTRIES = 20`, `MAX_CHARS = 8000`（予算上限）
- `filesChanged` は必須（`git diff --name-only` から取得）
- ユーザーメッセージは `tailTruncate`（末尾 500 文字）
- アシスタント抜粋は先頭 300 文字
- `formatForPrompt()`: 空なら `""` を返す（呼び出し側でセクション省略判断）

### 変更ファイル
- **新規**: `src/core/turn-log.ts`

---

## Step 3: `src/core/commit-hunks.ts` — commitHunks 抽出

### 目的
`agg-commit.ts` の private 関数 `commitHunks` を共有モジュールに抽出し、`batch-committer.ts` からも再利用可能にする。

### 抽出内容
- `commitHunks(pi, ctx, hunks)` 関数全体（`agg-commit.ts:116-186`）
- 依存関数: `resetStaging`, `stageFiles`（`git.ts` から import）
- 依存 i18n キー: `aggCommit.commitFailed`, `aggCommit.stagingResetFailed`（そのまま使用）

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
  turnLogText?: string,  // NEW
): Promise<Hunk[]>
```

- `turnLogText` が falsy でない場合、`buildPromptWithContext()` を使用
- falsy の場合、既存の `buildPrompt()` を使用（後方互換）
- バッチ分割時は `filterTurnLogForBatch()` でファイルセットに関連するエントリのみ部分送信

### 4b. `buildPromptWithContext()` 追加（i18n ベース）

新規 i18n キー `diffAnalyzer.buildPromptWithContext`:
```
=== GIT DIFF (PRIMARY) ===
```diff
{diff}
```

=== CONVERSATION LOG (supplementary) ===
{turnLogText}
```

### 4c. システムプロンプト拡張

新規 i18n キー `diffAnalyzer.systemPromptWithContext`:
- 優先順位ルール（diff > co-location > TurnLog Files > TurnLog text）
- 汎用メッセージ禁止事項（`autoCommitMsg.systemPrompt` から移植）
- 「1 ターン ≠ 1 hunk」の明示

### 4d. `processHunks()` に汎用メッセージチェック追加

```typescript
// processHunks() 内、sanitizeCommitMessage の後に追加:
if (isGenericMessage(hunk.message)) {
  hunk.message = generateFallbackMessage(hunk.files);
}
```

- `isGenericMessage` は `auto-commit-message.ts` から import
- `generateFallbackMessage` は `commit-message.ts` から import（既存）

### 変更ファイル
- **変更**: `src/core/diff-analyzer.ts`
- **変更**: `src/i18n/messages.ts`（新規キー追加）

---

## Step 5: `src/i18n/messages.ts` — 新規 i18n キー

### 追加キー一覧

| キー | en | ja | 用途 |
|------|----|----|------|
| `diffAnalyzer.systemPromptWithContext` | 拡張システムプロンプト | ←日本語版 | Hunk 分割 AI |
| `diffAnalyzer.buildPromptWithContext` | diff + TurnLog テンプレート | ←日本語版 | Hunk 分割 AI |
| `footer.autoCommit.accumulate` | `auto-commit: accumulate ({turns} turns) \| {files} files` | ←日本語版 | Footer 表示 |
| `footer.autoCommit.accumulateWarn` | `⚠ auto-commit: accumulate ({turns} turns) \| {files} files` | ←日本語版 | Footer 警告 |
| `footer.autoCommit.accumulateCritical` | `!! auto-commit: accumulate ({turns} turns) \| {files} files — run /git-agg-commit` | ←日本語版 | Footer 重大 |
| `config.keyDesc.auto_agg_commit_mode` | モード説明 | ←日本語版 | /git-config |
| `config.keyDesc.batch_warn_turns` | 閾値説明 | ←日本語版 | /git-config |
| `batchCommit.warnThreshold` | `{count} turns of uncommitted changes. Run /git-agg-commit to commit.` | ←日本語版 | 蓄積通知 |
| `batchCommit.modeSwitchNotice` | `accumulate mode: changes accumulate across turns. Use /git-agg-commit to commit.` | ←日本語版 | モード切替時 |

---

## Step 6: `src/utils/settings.ts` — 新規設定

### `PiGitSettings` に追加

```typescript
interface PiGitSettings {
  // ... existing fields ...
  auto_agg_commit_mode?: "per_turn" | "accumulate";
  batch_warn_turns?: number;
}
```

### `VALID_KEYS_META` に追加

```typescript
{
  key: "auto_agg_commit_mode",
  type: "string",
  messageKey: "config.keyDesc.auto_agg_commit_mode",
  valid_values: '"per_turn" or "accumulate"',
},
{
  key: "batch_warn_turns",
  type: "number",
  messageKey: "config.keyDesc.batch_warn_turns",
  valid_values: "positive integer (default: 5)",
}
```

### デフォルト値

```typescript
DEFAULT_SETTINGS = {
  // ... existing ...
  auto_agg_commit_mode: "per_turn",
  batch_warn_turns: 5,
}
```

### コンビニエンスゲッター

```typescript
export function getAutoAggCommitMode(cwd?: string): "per_turn" | "accumulate" { ... }
export function getBatchWarnTurns(cwd?: string): number { ... }
```

---

## Step 7: `src/commands/config.ts` — 新規キーバリデーション

### `ValidKey` に追加

```typescript
type ValidKey = 
  | "lang"
  | "auto_agg_commit"
  // ... existing ...
  | "auto_agg_commit_mode"   // NEW
  | "batch_warn_turns";       // NEW
```

### `validateValue()` に追加

```typescript
case "auto_agg_commit_mode":
  if (value !== "per_turn" && value !== "accumulate") {
    throw new Error(`Invalid auto_agg_commit_mode: ${value}. Must be "per_turn" or "accumulate".`);
  }
  return value;

case "batch_warn_turns": {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`Invalid batch_warn_turns: ${value}. Must be a non-negative integer.`);
  }
  return num;
}
```

---

## Step 8: `src/core/batch-committer.ts` — バッチコミットフロー

### 目的
accumulate モードで `/git-agg-commit` から呼ばれる一括コミットフロー。

### API
```typescript
async function batchCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  turnLog: TurnLog,
  langOverride?: string,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
}>
```

### フロー
```
1. hasChanges() チェック
2. collectDiff() で diff 収集
3. turnLog.formatForPrompt() で TurnLog シリアライズ
4. analyzeDiff(pi, ctx, diff, lang, turnLogText) で Hunk 分割
5. processHunks() で後処理（汎用検出含む）
6. --review フラグがあれば ReviewOverlay 表示
7. commitHunks() でシーケンシャルコミット
8. turnLog.clear() でログクリア
```

### 変更ファイル
- **新規**: `src/core/batch-committer.ts`

---

## Step 9: `src/utils/footer-manager.ts` — accumulate モード表示

### 追加メソッド

```typescript
setBatchStatus(turns: number, files: number): void {
  const key = turns >= batchWarnTurns * 2
    ? "footer.autoCommit.accumulateCritical"
    : turns >= batchWarnTurns
      ? "footer.autoCommit.accumulateWarn"
      : "footer.autoCommit.accumulate";
  
  this.ui.setStatus(STATUS_KEY, t(lang, key, {
    turns: String(turns),
    files: String(files),
  }));
}
```

### 変更ファイル
- **変更**: `src/utils/footer-manager.ts`

---

## Step 10: `src/core/auto-commit.ts` — モード分岐

### 変更内容

`handleAutoCommit()` の冒頭にモード分岐を追加：

```typescript
const mode = getAutoAggCommitMode(ctx.cwd);

if (mode === "accumulate") {
  // accumulate モード: コミットせず TurnLog 蓄積のみ
  await footerManager.setBatchStatus(turnLog.turnCount, turnLog.totalFilesChanged);
  
  if (turnLog.turnCount >= batchWarnTurns && batchWarnTurns > 0) {
    ctx.ui.notify(t(lang, "batchCommit.warnThreshold", { count: String(turnLog.turnCount) }), "warning");
  }
  return;
}

// per_turn モード: 既存の即時コミットフロー
// ... (existing code) ...
```

### `turnLog` 引数の受け渡し

`handleAutoCommit()` のシグネチャに `turnLog: TurnLog` を追加：

```typescript
export async function handleAutoCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: AgentEndEvent,
  turnLog: TurnLog,  // NEW
): Promise<void>
```

### 変更ファイル
- **変更**: `src/core/auto-commit.ts`
- **変更**: `src/index.ts`（呼び出し側で TurnLog を渡す）

---

## Step 11: `src/commands/agg-commit.ts` — TurnLog 統合

### 変更内容

`handleAggCommit()` に TurnLog を渡し、hunk 分析に活用：

```typescript
export async function handleAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  turnLog: TurnLog,  // NEW
): Promise<void>
```

- `commitHunks()` の import 先を `src/core/commit-hunks.js` に変更
- Hunk 分析前に TurnLog をシリアライズ:
  ```typescript
  const turnLogText = turnLog.formatForPrompt();
  const hunks = await analyzeDiff(pi, ctx, diff, runLang, turnLogText || undefined);
  ```
- コミット成功後に `turnLog.clear()`

### 変更ファイル
- **変更**: `src/commands/agg-commit.ts`
- **変更**: `src/index.ts`（呼び出し側で TurnLog を渡す）

---

## Step 12: `src/core/auto-commit-message.ts` — import 先変更

### 変更内容

- `collectMessagesByRole`, `extractTextContent`, `truncate` の import 先を `message-utils.js` に変更
- 重複定義を削除

### 変更ファイル
- **変更**: `src/core/auto-commit-message.ts`

---

## Step 13: `src/index.ts` — TurnLog ライフサイクル統合

### 変更内容

```typescript
import { TurnLog } from "./core/turn-log.js";

export default function (pi: ExtensionAPI) {
  let turnLog: TurnLog;  // セッションスコープ

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (ctx.hasUI) {
        turnLog = new TurnLog();  // NEW: セッション開始時に初期化
        footerManager.initialize(pi, ctx.ui, ctx.cwd);
        await recoverOrphanedStashes(pi, ctx);
        await footerManager.refresh();
      }
    } catch {
      // Silently ignore
    }
  });

  // ... registerCommand("git-agg-commit", ...) — handler に turnLog を渡す
  // ... registerCommand("git-config", ...) — 新規キー対応済み
  // ... pi.on("agent_end", ...) — handler に turnLog を渡す
}
```

### 変更ファイル
- **変更**: `src/index.ts`

---

## ファイル変更サマリー

| # | ファイル | 種別 | 内容 |
|---|---------|------|------|
| 1 | `src/utils/message-utils.ts` | **新規** | メッセージユーティリティ抽出 |
| 2 | `src/core/turn-log.ts` | **新規** | TurnLog クラス |
| 3 | `src/core/commit-hunks.ts` | **新規** | commitHunks 抽出 |
| 4 | `src/core/batch-committer.ts` | **新規** | バッチコミットフロー |
| 5 | `src/core/diff-analyzer.ts` | 変更 | analyzeDiff 拡張 + 汎用検出 |
| 6 | `src/i18n/messages.ts` | 変更 | 新規 i18n キー追加 |
| 7 | `src/utils/settings.ts` | 変更 | 新規設定追加 |
| 8 | `src/commands/config.ts` | 変更 | 新規キーバリデーション |
| 9 | `src/utils/footer-manager.ts` | 変更 | accumulate モード表示 |
| 10 | `src/core/auto-commit.ts` | 変更 | モード分岐追加 |
| 11 | `src/commands/agg-commit.ts` | 変更 | TurnLog 統合 + import 先変更 |
| 12 | `src/core/auto-commit-message.ts` | 変更 | import 先変更 |
| 13 | `src/index.ts` | 変更 | TurnLog ライフサイクル統合 |

---

## 実装上の注意点

1. **`turnLog` の型**: `src/index.ts` の `let turnLog: TurnLog` は `session_start` 前に `undefined` になりうる。`agent_end` / コマンドハンドラで `turnLog!` アサーションまたは `if (!turnLog) return` ガードを使用

2. **`isGenericMessage` の循環 import 回避**: `diff-analyzer.ts` が `auto-commit-message.ts` の `isGenericMessage` を import する。循環が発生しないか確認。発生する場合は `isGenericMessage` を `message-utils.ts` または `commit-message.ts` に移動

3. **バッチ分割 + TurnLog 部分フィルタ**: `analyzeDiff()` 内部のバッチ分割（8 ファイル以上）時、`turnLogText` がある場合は `filterTurnLogForBatch(batchFiles, turnLog)` で関連エントリのみにフィルタする。実装コストが高い場合は Phase 1 ではスキップし、全 TurnLog を全バッチに送る（8KB 上限があるので安全）

4. **後方互換性**: `analyzeDiff()` のシグネチャ変更は optional パラメータ追加なので、既存の呼び出し側（agg-commit.ts）を壊さない

5. **Footer の更新タイミング**: accumulate モードでは `agent_end` の度に `footerManager.setBatchStatus()` を呼ぶが、`footerManager.refresh()` がオーバーライドしないよう注意

6. **通知の重複防止**: `batch_warn_turns` 通知は一度表示したら再表示しない。TurnLog に `warnNotified: boolean` フラグを追加するか、単純にターン数が `batch_warn_turns` と等しい時だけ通知する（n === threshold でのみ発火）

7. **TurnLog が undefined のケース**: `session_start` が UI なし（RPC モード等）で発火しなかった場合、TurnLog は未初期化。コマンドハンドラは `if (!turnLog) return` で早期リターン
