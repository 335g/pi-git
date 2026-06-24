# pi-git Extension 実装プラン

## 概要

`myskill/SKILL.md` で定義された pi-git skill の動作を、pi 拡張機能（Extension + Command）として本リポジトリに実装する。従来の agent skill（プロンプト経由で手順を実行）から、pi の Extension API を用いたネイティブな `/commit` コマンドへ移行する。

## ディレクトリ構造

```
pi-git/                             # パッケージルート（本リポジトリ）
├── myskill/
│   ├── SKILL.md                    # 元の skill 定義（変更なし）
│   ├── IMPLEMENTATION-PLAN.md      # 本プラン
│   ├── .gitignore
│   ├── .pi/todos/
│   └── .agents/skills/grill-me/
├── .pi-git/config.toml             # pi-git 拡張機能の設定ファイル（lang 等）
├── .pi/settings.json               # pi プロジェクト設定
├── src/                            # TypeScript ソース（tsconfig.json の rootDir）
│   ├── index.ts                    # メインエントリポイント
│   ├── commit-message.ts           # Conventional Commits メッセージ生成ロジック
│   ├── config.ts                   # .pi-git/config.toml の読み込み
│   └── git-operations.ts           # git 操作のラッパー
├── dist/                           # ビルド出力（pi マニフェストが参照）
├── package.json                    # パッケージ全体の依存関係（既存）
├── tsconfig.json                   # 既存
└── biome.json                      # 既存
```

## 実装詳細

### 1. `src/index.ts` — エントリポイント

- `pi.registerCommand("commit", {...})` で `/commit` コマンドを登録
- コマンドハンドラ内でワークフロー全体を順次実行
- `ctx.ui` を用いた対話的確認（Y/N/Edit）

### 2. `src/config.ts` — 設定読み込み

- `.pi-git/config.toml` をプロジェクトルートから読み込む
- `lang` キーをパース:
  - `"ja"` → コミット本文は日本語、件名は英語
  - 未設定/その他 → 両方英語
- ファイルが存在しない場合もエラーにせずデフォルト動作（英語）
- プリセット検証済みTOMLパーサー（`smol-toml` 等）を利用

### 3. `src/git-operations.ts` — Git 操作

`pi.exec()` を用いて以下をラップ:

- `git status --short` — 変更の有無確認
- `git add -A` — 全ファイルステージ
- `git diff --cached --stat` — 変更ファイル一覧
- `git diff --cached` — 実際の差分
- `git diff --cached --name-status` — 変更種別（A/M/D/R）
- `git commit -m "..."` — コミット実行
- `git rev-parse --is-inside-work-tree` — Git リポジトリ確認（エッジケース）

### 4. `src/commit-message.ts` — メッセージ生成

SKILL.md のルールに従い Conventional Commits メッセージを生成:

**Type 判定:**

| Type | 条件 |
|------|------|
| `feat` | 新機能、新しいコマンド/オプション/API の実装 |
| `fix` | バグ修正、意図しない動作の修正 |
| `refactor` | 振る舞いを変えないコード構造の改善 |
| `chore` | ビルド設定、依存関係、CI、リポジトリ設定 |
| `docs` | ドキュメントのみの変更（README, SKILL.md, コメント） |
| `test` | テストの追加・変更 |
| `style` | コードフォーマット（振る舞いに影響なし） |
| `perf` | パフォーマンス改善 |

**複数タイプにまたがる場合:** 最も重要なものを type に、残りは body で説明。

**Scope:** 変更内容から適切なスコープを判定（固定リストはなし）。

**件名ルール:**
- 英語（`lang` の値に関わらず）
- 命令形現在形（"add", "fix", "update"）
- 小文字始まり
- 末尾にピリオド不要
- 50文字以内推奨

**本文ルール:**
- 変更ファイル一覧
- 各ファイルの変更内容の簡潔な説明
- 変更理由（可能な限り）
- `lang` の値に従った言語
- 72文字折り返し推奨

**Footer:**
- BREAKING CHANGE があれば `BREAKING CHANGE: ...` または `!` マーカーで明記

### 5. ユーザー確認（コマンドハンドラ内）

生成されたコミットメッセージを表示し、以下の選択肢を提示:

- **Y** → コミット実行（step 6 へ）
- **N** → 中断、ユーザーに指示を仰ぐ
- **編集リクエスト** → 指示に従いメッセージを修正して再確認

TUI モードでは `ctx.ui.confirm()` + `ctx.ui.input()` を利用。
RPC モードではフォールバックとして簡略化した確認フロー。

## エッジケース対応

| 状況 | 対応 |
|------|------|
| 変更なし | "No changes" を表示して終了 |
| 新規 Untracked ファイルのみ | `git add -A` で通常通り処理 |
| マージコンフリクト中 | 中断し、コンフリクト解決を促す（`git diff --cached` の成否等で検出） |
| 空コミット（全変更が既にステージ済み） | 通常通り `git commit` を実行 |
| Git リポジトリでない | エラーメッセージを表示して終了（`rev-parse` で検出） |

## pi 拡張機能としての設計判断

| 判断 | 理由 |
|------|------|
| **Command（`/commit`）** として実装（Tool ではない） | このワークフローはユーザーが能動的にトリガーするものであり、LLM が自動呼び出しする Tool より Command が適切。対話的な確認ステップが必要なため。 |
| **`pi.exec()` で git コマンドを直接実行** | `bash` tool を経由する必要はなく、拡張機能内で直接 git プロセスを起動する方が制御しやすい。 |
| **スキルファイルは維持** | 拡張機能が追加されても、従来の agent skill としての利用を引き続き可能にするため。 |
| **設定ファイルは `.pi-git/config.toml`（変更なし）** | 既存の設定場所と形式を維持し、互換性を保つ。 |
| **`package.json` には `smol-toml` のみ依存追加** | TOML パースに軽量ライブラリを使用。pi バンドルの typebox 等は peerDependencies。 |

## 実装ステップ

1. **パッケージのセットアップ**
   - `package.json` は既存のものを流用（dependencies に `smol-toml` は追加済み）
   - npm install 済み

2. **設定読み込み (`config.ts`)**
   - `.pi-git/config.toml` の読み込み・パース
   - デフォルト値処理

3. **Git 操作ラッパー (`git-operations.ts`)**
   - `pi.exec()` を用いた各 git 操作の実装
   - エラーハンドリング、エッジケース

4. **コミットメッセージ生成 (`commit-message.ts`)**
   - 変更分析（diff stat, name-status, diff）
   - Type/Scope 判定ロジック
   - 件名・本文生成
   - lang 対応

5. **コマンド登録 (`index.ts`)**
   - `/commit` コマンドの登録
   - ワークフローの統合
   - ユーザー確認 UI
   - エッジケース処理

6. **検証**
   - スキルファイルとの挙動の突合せ確認
