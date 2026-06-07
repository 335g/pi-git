# Implementation Plan: Delete Global Config (`--delete-global`)

## 背景

現在の `/git-config` は以下の操作をサポートしている：

- `--init` / `--force`: ローカル設定ファイル (`pi-git.toml`) を作成
- `--global`: グローバル設定 (`~/.config/pi-git/settings.json`) への書き込み
- `--list`, `--show-origin`, `--keys`, `--models`: 情報表示
- キーの get/set

**不足している操作**: 設定ファイルを削除する手段。ローカルの初期化 (`--init`) ができるのに、グローバル設定を削除する方法がない。

## 要件

`/git-config --delete-global` で `~/.config/pi-git/settings.json` を削除できるようにする。

## 設計判断

### フラグ名: `--delete-global`

代替案とその棄却理由:

| 案 | 判定 | 理由 |
|----|------|------|
| `--delete` (単独、スコープは `--global` で指定) | ❌ 不採用 | `--delete` 単独だと「何を消すのか」が不明瞭。`--global` は現在「書き込み先スコープを指定する補助フラグ」であり、`--delete` + `--global` の組み合わせでは `--delete` が動詞、`--global` が目的語のようで分かりにくい |
| `--unset` | ❌ 今回は不採用 | キー単位の削除は有用だが、今回の要件は「ファイルごと削除」。`--unset` は別タスクとして後日対応 |
| `--delete-global` | ✅ 採用 | 操作対象が明示的。将来的に `--delete-local` も追加しやすい |

### 安全性

- 破壊的操作だが `/git-config` はユーザーが明示的にタイプするため、追加の確認プロンプトは不要と判断
- ファイルが存在しない場合は「見つかりませんでした」と通知し正常終了（エラーではない）
- 削除後はインメモリキャッシュをクリアする

## 変更ファイル一覧

### 1. `src/utils/settings.ts`

**追加する関数:**

```typescript
import { unlinkSync } from "node:fs";

export function deleteGlobalSettings(): { deleted: boolean; error?: string } {
  if (!existsSync(GLOBAL_SETTINGS_FILE)) {
    return { deleted: false, error: "not found" };
  }
  try {
    unlinkSync(GLOBAL_SETTINGS_FILE);
    cache.clear();
    return { deleted: true };
  } catch (err) {
    return {
      deleted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- `unlinkSync` は既に `node:fs` から import されていないため、import 行に追加が必要
- 戻り値はオブジェクト型で、呼び出し元がエラーハンドリングしやすいようにする

### 2. `src/commands/config.ts`

**フラグパースに追加:**

```typescript
let deleteGlobalFlag = false;  // 追加
// ...
else if (token === "--delete-global") deleteGlobalFlag = true;  // 追加
```

**ハンドラを追加（`--help`, `--init`, `--keys`, `--models`, `--list` のブロックの後、positional 処理の前に配置）:**

```typescript
if (deleteGlobalFlag) {
  const { deleted, error } = deleteGlobalSettings();
  if (deleted) {
    ctx.ui.notify(t(lang, "config.deleteGlobalSuccess"), "info");
  } else if (error === "not found") {
    ctx.ui.notify(t(lang, "config.deleteGlobalNotFound"), "info");
  } else {
    ctx.ui.notify(
      t(lang, "config.deleteGlobalFailed", { error }),
      "error",
    );
  }
  return;
}
```

**ヘルプテキストの `--force` 行の後に追記:**

```
  --delete-global  Delete global config file (~/.config/pi-git/settings.json)
```

（日本語版も同様に追記）

### 3. `src/i18n/messages.ts`

**英語 (`en`) に追加:**

```typescript
"config.deleteGlobalSuccess":
  "[pi-git] Deleted global config file (~/.config/pi-git/settings.json).",
"config.deleteGlobalNotFound":
  "[pi-git] Global config file not found. Nothing to delete.",
"config.deleteGlobalFailed":
  "[pi-git] Failed to delete global config: {error}",
```

**日本語 (`ja`) に追加:**

```typescript
"config.deleteGlobalSuccess":
  "[pi-git] グローバル設定ファイル (~/.config/pi-git/settings.json) を削除しました。",
"config.deleteGlobalNotFound":
  "[pi-git] グローバル設定ファイルが見つかりません。削除するものはありません。",
"config.deleteGlobalFailed":
  "[pi-git] グローバル設定の削除に失敗しました: {error}",
```

**ヘルプテキスト更新（英語）:**

`config.help` の `--force` 行の後に以下を追加:
```
  --delete-global  Delete global config file (~/.config/pi-git/settings.json)
```

**ヘルプテキスト更新（日本語）:**

`config.help` の `--force` 行の後に以下を追加:
```
  --delete-global  グローバル設定ファイル (~/.config/pi-git/settings.json) を削除
```

### 4. `docs/commands.ja.md`

`/git-config` セクションの「使い方」ブロックに追記:

```
# グローバル設定ファイルを削除
/git-config --delete-global
```

`--init` の説明の下あたりにフラグの説明を追記:

```
| `--delete-global` | グローバル設定ファイル (`~/.config/pi-git/settings.json`) を削除します |
```

### 5. `docs/commands.md`（英語版）

同様の変更を英語版にも適用。

## エッジケース

| ケース | 動作 |
|--------|------|
| グローバル設定ファイルが存在しない | `config.deleteGlobalNotFound` を通知して正常終了 |
| パーミッションエラーで削除できない | `config.deleteGlobalFailed` にエラーメッセージを入れて通知 |
| ディレクトリ `~/.config/pi-git/` が空になる | ディレクトリは削除しない（他の将来のファイルが入る可能性があるため） |
| 削除後もインメモリキャッシュに古い値が残る | `cache.clear()` により全キャッシュを破棄 |
| 他のフラグと同時指定された場合 | 最初にマッチしたフラグの処理のみ行う（既存の制御フローに従う） |

## テスト方針

1. **手動テスト**:
   - `~/.config/pi-git/settings.json` が存在する状態で `/git-config --delete-global` を実行 → 削除成功メッセージ
   - ファイルが存在しない状態で再度実行 → 「見つかりません」メッセージ
   - 削除後、`/git-config --list --show-origin` ですべての値が `default` になることを確認

2. **自動テスト** (推奨、別タスク):
   - `settings.test.ts` に `deleteGlobalSettings()` のユニットテストを追加
   - 一時ディレクトリを使ったファイル I/O のテスト

## 実装順序

1. `settings.ts`: `deleteGlobalSettings()` 関数を追加、`unlinkSync` を import
2. `messages.ts`: メッセージキーを en/ja 両方に追加、ヘルプテキスト更新
3. `config.ts`: フラグパースとハンドラを追加
4. `docs/commands.ja.md`, `docs/commands.md`: ドキュメント更新
5. 手動テスト
