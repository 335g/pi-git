# auto_agg_commit への git diff 追加 & analysis_model 改善 実装プラン

## 背景

1. `auto_agg_commit` は会話履歴のみからコミットメッセージを生成する。git diff を AI に送っていないため、弱いモデルでは会話の意図を読み取れず `chore: apply changes` のような抽象的なメッセージになりやすい。
2. `analysis_model` に `"gpt-5.4"` のような `/` 区切りなしのモデル名を指定しても、`resolveModel()` がサイレントにスキップし、セッションモデルにフォールバックする。

---

## 実装項目

### A. `auto_agg_commit` に git diff を送信する

#### A-1. `auto-commit.ts`: git diff の取得

`handleAutoCommit()` 内で、`git status --short` の後に `git diff -- <files>` で差分を取得する。

```typescript
// 追加: 変更ファイルの diff を取得（トラック済みファイルのみ）
const { stdout: diffOutput } = await pi.exec(
  "git",
  ["diff", "--", ...changedFiles],
  { cwd: ctx.cwd },
);
```

- `git diff` はトラック済みファイルの unstaged 変更のみを表示する
- 新規ファイル（untracked）は diff に出ないが、ファイル名はすでにプロンプトに含まれている
- 全ファイルが untracked で diff が空の場合は、それを示すテキストをプロンプトに含める

`generateAutoCommitMessage()` のシグネチャ変更:
```typescript
export async function generateAutoCommitMessage(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: SimpleMessage[],
  changedFiles: string[],
  diff: string,  // 追加
): Promise<string>
```

#### A-2. `auto-commit-message.ts`: プロンプトへの diff 組み込み

**バジェット再配分:**

| セクション | 変更前 | 変更後 |
|---|---|---|
| User messages | 2000 | 1500 |
| Assistant messages | 800 | 600 |
| Files | 800 | 500 |
| **Git diff (新規)** | - | **5000** |
| 合計 | ~3600 | ~7600 |

**`buildPrompt()` の変更:**
```
{examples}

=== USER REQUEST (primary) ===
{userSection}

=== ASSISTANT RESPONSE (reference) ===
{assistantSection}

=== CHANGED FILES ===
{filesSection}

=== GIT DIFF (what actually changed) ===  ← 追加
{diffSection}

Based primarily on the GIT DIFF and USER REQUEST above, generate a single Conventional Commit message...
```

**`stripDiffNoise()` の共通化:**
- `diff-analyzer.ts` の `stripDiffNoise()` を `diff-utils.ts` に抽出し、両方から import する
- もしくは `auto-commit-message.ts` から `diff-analyzer.ts` の関数を直接 import する

#### A-3. `i18n/messages.ts`: プロンプト文言の更新

**`autoCommitMsg.systemPrompt` (en):**
```
"You are a commit message generator. From the following information, understand
what the user requested and what changes were made as a result, then generate a
single Conventional Commit message.

The GIT DIFF is the most reliable source of what actually changed. Use it as the
primary driver for the commit message. The user's request provides intent, and
the assistant's response and changed files list are supplementary.

Rules:
- Choose type from: feat, fix, docs, style, refactor, test, chore
- Write the subject in English
- Keep subject under 50 characters
- Use imperative mood
- Include scope only if clearly inferable from the diff

Return ONLY the commit message string. No explanations or code fences."
```

**`autoCommitMsg.buildPrompt` (en):**
```
{examples}

=== USER REQUEST (primary) ===
{userSection}

=== ASSISTANT RESPONSE (reference) ===
{assistantSection}

=== CHANGED FILES ===
{filesSection}

=== GIT DIFF ===
{diffSection}

Based on the GIT DIFF and USER REQUEST above, generate a single Conventional
Commit message in English that best captures the intent of the changes.
```

日本語版も同様に更新。

---

### B. `analysis_model` 解決の堅牢化

#### B-1. `/` なしモデル名のフォールバック検索 (`resolve-model.ts`)

現在:
```typescript
const slashIndex = configuredModel.indexOf("/");
if (slashIndex > 0) {
  // provider/model-id 形式のみ処理
}
// slashIndex <= 0 の場合は何もせずフォールバック
```

変更後:
```typescript
const slashIndex = configuredModel.indexOf("/");
if (slashIndex > 0) {
  // 既存: provider/model-id 形式
  const provider = configuredModel.substring(0, slashIndex);
  const modelId = configuredModel.substring(slashIndex + 1);
  const found = ctx.modelRegistry.find(provider, modelId);
  if (found) return found;
} else {
  // 追加: "/" なしの場合、全プロバイダーから modelId に一致するものを検索
  const available = ctx.modelRegistry.getAvailable();
  const found = available.find(
    (m) => m.id === configuredModel || `${m.provider}/${m.id}` === configuredModel
  );
  if (found) return found;
}
```

#### B-2. デバッグ用ログ出力

`resolveModel()` が解決したモデル名を `console.log` または UI notify で出力する。
- 本番では `console.log` レベルが適切（UI notify はノイズになる）
- もしくは `--verbose` フラグ時のみ

```typescript
const resolved = /* ... */;
if (resolved) {
  console.log(`[pi-git] Using model: ${resolved.provider}/${resolved.id}`);
} else {
  console.log(`[pi-git] No model resolved, AI features disabled`);
}
return resolved;
```

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/core/auto-commit.ts` | `git diff` 取得と `generateAutoCommitMessage` への引き渡し |
| `src/core/auto-commit-message.ts` | シグネチャ変更、プロンプトに diff セクション追加、バジェット調整 |
| `src/core/resolve-model.ts` | `/` なしモデル名のフォールバック検索、デバッグログ追加 |
| `src/i18n/messages.ts` | `autoCommitMsg.systemPrompt`, `autoCommitMsg.buildPrompt` (en/ja) 更新 |

---

## リスク・検討事項

1. **diff が巨大な場合**: 5000 文字でトランケートするが、バイナリファイルや大量の変更がある場合はノイズ除去（`stripDiffNoise`）を先に適用する
2. **untracked ファイルのみの場合**: diff が空文字列になる。プロンプトには `"(no diff available — new files)"` のようなフォールバックテキストを入れる
3. **プロンプト長の増加**: ~3600 → ~7600 文字に増えるが、ほとんどのモデルで問題ない範囲。ただし GPT-3.5 系の小さいコンテキストウィンドウでは注意
4. **`auto_agg_commit` の応答時間**: diff 取得は `git diff` の同期的な呼び出しで、通常 1 秒未満。AI 呼び出しのレイテンシへの影響は軽微
