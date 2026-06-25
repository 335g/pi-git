# @335g/pi-git

[![npm version](https://img.shields.io/npm/v/@335g/pi-git.svg)](https://www.npmjs.com/package/@335g/pi-git)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) の拡張機能です。
LLM またはヒューリスティックフォールバックを用いて [Conventional Commits](https://www.conventionalcommits.org/) 形式のコミットメッセージを生成する `/commit` コマンドを追加します。

## 特徴

- **`/commit` コマンド** – 変更をすべてステージし、コミットメッセージを生成して実行
- **インラインコミットメッセージ** – `/commit fix typo` のようにメッセージを直接指定すると AI 生成をスキップ
- **AI による生成** – pi の LLM を利用してステージされた差分から Conventional Commits メッセージを生成
- **ヒューリスティックフォールバック** – LLM が利用できない場合、差分解析からコミットメッセージを生成
- **言語対応** – コミット本文を英語または日本語で記述可能（`.pi-git/config.toml` で設定）
- **対話型確認** – 生成されたコミットメッセージを確認・編集・キャンセルしてから実行
- **自動コミット** – `commit_every_turn = true` 設定で各エージェントターン終了時に自動コミット
- **マージコンフリクト検出** – マージ競合中はコミットを拒否

## インストール

```bash
pi install @335g/pi-git
```

または pi のパッケージ設定に追加:

```json
{
  "packages": {
    "@335g/pi-git": "latest"
  }
}
```

## 使い方

### 基本コミット

pi セッション内で、git リポジトリの中で以下を実行:

```
/commit
```

以下の処理が自動で行われます:
1. マージコンフリクトの確認
2. 未コミットの変更の確認
3. 全ファイルをステージ (`git add -A`)
4. ステージされた差分の解析
5. LLM による Conventional Commits メッセージの生成
6. メッセージの確認表示
7. コミットの実行

### インラインコミットメッセージ

```
/commit fix typo in header
```

AI 生成をスキップし、指定されたメッセージで即座にコミットします。

### 設定

プロジェクトルートに `.pi-git/config.toml` を作成:

```toml
# .pi-git/config.toml
lang = "ja"              # コミットメッセージの言語: "ja"（日本語）または "en"（英語、デフォルト）
no_body = true           # ボディを省略し件名のみに（デフォルト: false）
commit_every_turn = true # 各エージェントターン終了時に自動コミット（デフォルト: false）
```

#### `commit_every_turn`

有効にすると、拡張機能が `agent_end` イベントを検知し、自動的に以下を実行します:
1. 未コミットの変更がないか確認
2. 全ファイルをステージ (`git add -A`)
3. LLM で Conventional Commits メッセージを生成
4. コミットを実行

バックグラウンドで動作し、進捗やエラーは UI に通知されますが、
対話的な確認は不要です。手動の `/commit` と併用しても安全です。
実際に変更がある場合のみコミットします。

## コミットメッセージ規約

生成されるメッセージは [Conventional Commits](https://www.conventionalcommits.org/) 仕様に従います:

```
type(scope): subject

body

footer
```

### タイプ一覧

| タイプ      | 説明                               |
|------------|-----------------------------------|
| `feat`     | 新機能、コマンド、オプション、API     |
| `fix`      | バグ修正、意図しない動作の修正        |
| `refactor` | 振る舞いを変えないコード構造の改善     |
| `chore`    | ビルド設定、依存関係、CI、リポジトリ設定 |
| `docs`     | ドキュメントのみの変更               |
| `test`     | テストの追加・修正                   |
| `style`    | コードフォーマット（振る舞いに影響なし）|
| `perf`     | パフォーマンス改善                   |

## 開発

```bash
# 依存関係のインストール
npm install

# ビルド
npm run build

# テスト実行
npm test
```

## 必要条件

- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)（ピア依存関係）
- [pi-ai](https://github.com/earendil-works/pi-ai)（ピア依存関係）
- [pi-tui](https://github.com/earendil-works/pi-tui)（オプションのピア依存関係 – 対話型確認 UI を有効化）

## ライセンス

MIT © Yoshiki Kudo
