# `--init` フラグ実装プラン

## 概要

`/git-config --init` を実行すると、カレントの Git リポジトリルートにデフォルト設定を含む `pi-git.toml` を生成する。

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/i18n/messages.ts` | 新規 i18n メッセージキー追加 (en/ja) |
| `src/commands/config.ts` | `--init` フラグのパース / ハンドリングロジック追加 |
| `src/utils/settings.ts` | `initLocalSettings()` 関数の追加 |

---

## 1. `src/i18n/messages.ts` — メッセージキー追加

`config` ドメインに以下を追加:

```ts
// en
"config.initCreated":
  "[pi-git] Created default pi-git.toml in the repository root.",
"config.initAlreadyExists":
  "[pi-git] pi-git.toml already exists. Use --init --force to overwrite.",
"config.initOverwritten":
  "[pi-git] Overwritten pi-git.toml with default settings.",
"config.initNotInRepo":
  "[pi-git] Not inside a git repository. Cannot create pi-git.toml.",

// ja
"config.initCreated":
  "[pi-git] リポジトリルートにデフォルトの pi-git.toml を作成しました。",
"config.initAlreadyExists":
  "[pi-git] pi-git.toml はすでに存在します。上書きするには --init --force を使用してください。",
"config.initOverwritten":
  "[pi-git] pi-git.toml をデフォルト設定で上書きしました。",
"config.initNotInRepo":
  "[pi-git] Git リポジトリ内ではありません。pi-git.toml を作成できません。",
```

`config.help` (en) のフラグ一覧に以下を追記:

```
  --init           Create default pi-git.toml in the repository root
  --force          Force overwrite when used with --init
```

`config.help` (ja) のフラグ一覧に以下を追記:

```
  --init           リポジトリルートにデフォルトの pi-git.toml を作成
  --force          --init と併用して強制的に上書き
```

また、usage 行（最初の行）の `[--help]` の前に `[--init] [--force]` を追加する（en/ja 両方）。

---

## 2. `src/utils/settings.ts` — `initLocalSettings()` 追加

```ts
/**
 * Create (or overwrite) pi-git.toml with DEFAULT_SETTINGS at the repo root.
 *
 * @param cwdOrPath - Working directory (to resolve git root) or an already-resolved
 *   local settings path. If a path ending in "pi-git.toml" is passed, it is used directly
 *   without re-running git rev-parse.
 * @returns The written path, or null if not inside a git repo.
 */
export function initLocalSettings(cwdOrPath?: string): string | null {
  const localPath = cwdOrPath?.endsWith("pi-git.toml")
    ? cwdOrPath
    : getLocalSettingsPath(cwdOrPath);
  if (!localPath) return null;
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, stringifyToml(DEFAULT_SETTINGS), "utf-8");
  cache.clear();
  return localPath;
}
```

**設計意図**: `saveLocalSettings` は既存設定との merge を行うが、`initLocalSettings` は常に `DEFAULT_SETTINGS` で上書きする。責務が異なるため新規関数として分離する。

---

## 3. `src/commands/config.ts` — `--init` / `--force` フラグ追加

### 3-1. フラグパース

既存のフラグ parse ブロックに以下を追加:

```ts
let init = false;
let force = false;
// ...
else if (token === "--init") init = true;
else if (token === "--force") force = true;
```

### 3-2. ハンドリングロジック

`--init` が指定された場合、他のフラグ・位置引数より優先して処理する:

```ts
if (init) {
  const localPath = getLocalSettingsPath(ctx.cwd);
  if (!localPath) {
    ctx.ui.notify(t(lang, "config.initNotInRepo"), "warning");
    return;
  }

  // existsSync は initLocalSettings の前に評価する（上書き後は常に true になるため）
  const existed = existsSync(localPath);
  if (existed && !force) {
    ctx.ui.notify(t(lang, "config.initAlreadyExists"), "warning");
    return;
  }

  try {
    // localPath を渡すことで git rev-parse の二重呼び出しを回避
    initLocalSettings(localPath);
    ctx.ui.notify(
      t(lang, existed ? "config.initOverwritten" : "config.initCreated"),
      "info",
    );
  } catch (err) {
    ctx.ui.notify(
      t(lang, "config.saveFailed", {
        error: err instanceof Error ? err.message : String(err),
      }),
      "error",
    );
  }
  return;
}
```

### 3-3. import 追加

```ts
import { ..., initLocalSettings } from "../utils/settings.js";
```

---

## 動作シナリオ

| 状況 | 結果 |
|---|---|
| Git リポジトリ内、`pi-git.toml` なし | デフォルト設定で `pi-git.toml` を作成し、成功メッセージ |
| Git リポジトリ内、`pi-git.toml` あり | 警告メッセージ（既存ファイルあり） |
| Git リポジトリ内、`pi-git.toml` あり + `--force` | デフォルト設定で上書きし、上書きメッセージ |
| Git リポジトリ外 | 警告メッセージ（リポジトリ外） |

---

## 生成される `pi-git.toml` の内容

```toml
lang = "en"
auto_agg_commit = false
analysis_model = ""
```

---

## 非対応 (スコープ外)

- `--global` との組み合わせ（`--init` は常にローカル。`--global` 指定時は警告する or 無視する）
  - → 今回は `--init` と `--global` が同時指定された場合の動作は**未定義**（`--init` を優先）。必要に応じて将来対応する。
