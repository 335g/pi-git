# Implementation Plan: Migrate local settings from `.pi-git/settings.json` to `pi-git.toml`

## Overview

- **Goal**: ローカル設定の保存先を `<repo-root>/.pi-git/settings.json` から `<repo-root>/pi-git.toml` に変更する
- **Scope**: ローカル設定のみ。グローバル設定 (`~/.config/pi-git/settings.json`) は現状維持
- **Format change**: JSON → TOML
- **Estimated effort**: 中規模（設定I/Oのコア部分 + ドキュメント更新 + マイグレーション対応）

---

## Impact Analysis

### 影響を受けるファイル一覧

| ファイル | 変更内容 | 重要度 |
|----------|----------|--------|
| `src/utils/settings.ts` | コアの読み書きロジックを JSON→TOML に変更 + レガシー設定の自動マイグレーション追加 | 🔴 高 |
| `src/commands/config.ts` | ドキュメントコメント・エラーメッセージのパス表記を更新 | 🟡 中 |
| `src/commands/auto-agg-commit.ts` | 直接のパス参照なし。`saveLocalSettings()` 経由のため変更不要 | 🟢 低 |
| `docs/commands.md` | 全パス参照と設定ファイルセクションの更新。gitignore・コメント消失の注意書き追加 | 🟡 中 |
| `docs/commands.ja.md` | 同上（日本語版） | 🟡 中 |
| `README.md` | パス表記の更新 | 🟡 中 |
| `README.ja.md` | 同上 | 🟡 中 |
| `.gitignore` | `pi-git.toml` をignoreに追加（pi-git自身の開発リポジトリ用） | 🟡 中 |
| `package.json` | TOMLパーサー依存の追加 | 🔴 高 |
| `CHANGELOG.md` | **新規作成**。マイグレーション手順と本バージョンの変更点を記載 | 🟡 中 |

### 影響を受けないファイル

- `src/core/*` — 設定ファイルの読み書きを直接行っていない
- `src/utils/lang.ts`, `src/utils/diagnostics.ts`, `src/utils/footer-manager.ts` — settings API経由でアクセス
- `src/i18n/*` — メッセージキーはパスを含まない設計のため（`settings.json` という文字列はi18nに含まれていない）

> **Note**: `dist/*` はビルド成果物であり、`tsc` 再実行で自動的に再生成される。JSDocコメントを含む `.d.ts` ファイルも新しいパス表記で再生成されるため、手動での変更は不要。

---

## Detailed Change Plan

### Step 1: TOMLライブラリの追加

`package.json` の `dependencies` に TOML パーサーを追加する。

```bash
npm install smol-toml
```

**選択理由**: `smol-toml` は軽量（~3KB min+gzip）、依存ゼロ、ESMネイティブ対応、TypeScript型付き。`parse` と `stringify` の両方をnamed exportしている。

```json
// package.json に追記
{
  "dependencies": {
    "smol-toml": "^1.0.0"
  }
}
```

### Step 2: `src/utils/settings.ts` の変更

#### 2a. 定数の変更

`LOCAL_SETTINGS_DIR` 定数は削除し、`LOCAL_SETTINGS_FILE` を新しいファイル名に変更:

```diff
-const LOCAL_SETTINGS_DIR = ".pi-git";
-const LOCAL_SETTINGS_FILE = "settings.json";
+const LOCAL_SETTINGS_FILE = "pi-git.toml";

+// Legacy path for automatic migration
+import { renameSync } from "node:fs";
+const LEGACY_LOCAL_SETTINGS_DIR = ".pi-git";
+const LEGACY_LOCAL_SETTINGS_FILE = "settings.json";
```

#### 2b. `getLocalSettingsPath()` の変更

```diff
 export function getLocalSettingsPath(cwd?: string): string | null {
   try {
     const repoRoot = execSync("git rev-parse --show-toplevel", {
       cwd,
       encoding: "utf-8",
       stdio: ["pipe", "pipe", "ignore"],
     }).trim();
     if (!repoRoot) return null;
-    return join(repoRoot, LOCAL_SETTINGS_DIR, LOCAL_SETTINGS_FILE);
+    return join(repoRoot, LOCAL_SETTINGS_FILE);
   } catch {
     return null;
   }
 }
```

#### 2c. TOML読み込み関数の追加

`loadJson(path)` はグローバル設定読み込み用に残しつつ、ローカル設定用に `loadToml(path)` を追加:

```typescript
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

function loadToml(path: string): PiGitSettings | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseToml(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as PiGitSettings;
  } catch {
    return null;
  }
}
```

#### 2d. レガシー設定の自動マイグレーション関数を追加

既存ユーザーの `.pi-git/settings.json` が存在し、かつ `pi-git.toml` が存在しない場合、自動的にマイグレーションを行う。これにより**サイレントデータロスを防止**する。

```typescript
function migrateLegacySettings(cwd?: string): void {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (!repoRoot) return;

    const legacyPath = join(repoRoot, LEGACY_LOCAL_SETTINGS_DIR, LEGACY_LOCAL_SETTINGS_FILE);
    const newPath = join(repoRoot, LOCAL_SETTINGS_FILE);

    // 新しいファイルが既に存在する、またはレガシーファイルが存在しない場合は何もしない
    if (existsSync(newPath) || !existsSync(legacyPath)) return;

    // レガシーJSONを読み込んでTOMLとして書き出し
    const legacy = loadJson(legacyPath);
    if (legacy && Object.keys(legacy).length > 0) {
      writeFileSync(newPath, stringifyToml(legacy), "utf-8");
      // レガシーファイルをバックアップにリネーム
      renameSync(legacyPath, `${legacyPath}.bak`);
      console.warn(
        `[pi-git] Migrated legacy .pi-git/settings.json → pi-git.toml. ` +
        `Old file renamed to .pi-git/settings.json.bak`
      );
    }
  } catch {
    // マイグレーション失敗時はサイレントに無視（次回再試行される）
  }
}
```

#### 2e. `loadRaw()` 内でマイグレーションを呼び出し、ローカル設定の読み込みをTOMLに変更

```diff
 function loadRaw(cwd?: string): {
   global: PiGitSettings;
   local: PiGitSettings | null;
 } {
   const global = loadJson(GLOBAL_SETTINGS_FILE) ?? {};
+  migrateLegacySettings(cwd);
   const localPath = getLocalSettingsPath(cwd);
-  const local = localPath ? loadJson(localPath) : null;
+  const local = localPath ? loadToml(localPath) : null;
   return { global, local };
 }
```

> **Note**: `migrateLegacySettings()` は `loadRaw()` のタイミング（=`getSettings()` や `saveLocalSettings()` の初回呼び出し時）で実行される。新しいファイルが既に存在する場合は何もしない。一度だけ実行されるためパフォーマンス影響は無視できる。

#### 2f. `saveLocalSettings()` の変更（JSON → TOML書き出し）

```diff
 export function saveLocalSettings(
   settings: Partial<PiGitSettings>,
   cwd?: string,
 ): void {
   const localPath = getLocalSettingsPath(cwd);
   if (!localPath) {
     throw new Error("Not inside a git repository");
   }
   mkdirSync(dirname(localPath), { recursive: true });
-  const current = loadJson(localPath) ?? {};
+  const current = loadToml(localPath) ?? {};
   const updated = { ...current, ...settings };
-  writeFileSync(localPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
+  writeFileSync(localPath, stringifyToml(updated), "utf-8");
   cache.clear();
 }
```

> **Note**: `mkdirSync(dirname(localPath), ...)` は `pi-git.toml` がリポジトリルート直下に置かれるため、基本的に常に存在するディレクトリになる。`recursive: true` は安全のため残す。

#### 2g. JSDocコメントの更新

```diff
 /**
  * Persistent settings storage for pi-git extension.
  *
  * Settings are stored in:
  * - Global: ~/.config/pi-git/settings.json
- * - Local:  <git-root>/.pi-git/settings.json (takes precedence)
+ * - Local:  <git-root>/pi-git.toml (takes precedence)
  */
```

### Step 3: `src/commands/config.ts` の変更

ドキュメントコメントのパス表記のみ更新。コードロジックは `getLocalSettingsPath()` と `saveLocalSettings()` に依存しているため変更不要。

```diff
 /**
  * /git-config command
  *
  * Get, set, and list pi-git configuration values.
  * Supports both global (~/.config/pi-git/settings.json)
- * and local (<repo>/.pi-git/settings.json) scopes.
+ * and local (<repo>/pi-git.toml) scopes.
  */
```

### Step 4: `src/commands/auto-agg-commit.ts`

変更不要（`saveLocalSettings`, `getLocalSettingsPath` 経由でアクセスしているため）。

### Step 5: TOML round-trip 手動テスト

実装後、ビルド前に以下の手動テストを実施し、TOMLパーサーが期待通り動作することを確認する。

#### テストケースと合格基準

```typescript
// test-toml-roundtrip.ts（一時ファイル、テスト後に削除）
import { parse, stringify } from "smol-toml";

// Case 1: 全キーあり
const input1 = { lang: "ja", auto_agg_commit: true, analysis_model: "anthropic/claude-sonnet" };
const toml1 = stringify(input1);
console.assert(toml1.includes('lang = "ja"'), "Case 1: lang present");
console.assert(toml1.includes("auto_agg_commit = true"), "Case 1: auto_agg_commit present");
console.assert(toml1.includes('analysis_model = "anthropic/claude-sonnet"'), "Case 1: analysis_model present");
const round1 = parse(toml1);
console.assert(round1.lang === "ja", "Case 1: lang round-trip");
console.assert(round1.auto_agg_commit === true, "Case 1: auto_agg_commit round-trip");

// Case 2: 空文字列を含む
const input2 = { lang: "en", auto_agg_commit: false, analysis_model: "" };
const toml2 = stringify(input2);
console.assert(toml2.includes('analysis_model = ""'), "Case 2: empty string present");
console.assert(toml2.includes("auto_agg_commit = false"), "Case 2: false present");

// Case 3: 空オブジェクト
const input3 = {};
const toml3 = stringify(input3);
console.assert(toml3 === "" || toml3 === "\n", "Case 3: empty object → empty output");

// Case 4: parse round-trip for empty input
const round2 = parse(toml2);
console.assert(round2.auto_agg_commit === false, "Case 4: false round-trip");
console.assert(round2.analysis_model === "", "Case 4: empty string round-trip");

console.log("✅ All TOML round-trip tests passed");
```

合格条件: 全 assert がパスすること（`node --import tsx test-toml-roundtrip.ts` で実行）。

### Step 6: ビルドと検証

```bash
npm run build
```

`tsc` でコンパイルエラーがないことを確認。

### Step 7: `.gitignore` の更新（必須）

`pi-git.toml` はリポジトリルート直下に置かれる。現状の `.pi-git/` ignoreルールの対象外であるため、以下の対応を行う:

1. **pi-git 自身の開発リポジトリの `.gitignore` に `pi-git.toml` を追加する**

```diff
 .pi-git/
+pi-git.toml
 .npmrc
```

理由: pi-git 拡張機能の開発中に `/git-config` を実行するとリポジトリルートに `pi-git.toml` が作成される。これは開発者個人の設定であり、リポジトリにコミットすべきではない。

2. **`.pi-git/` のignoreは安全のため残す**
   - 他の `.pi-git/` 内ファイルが存在する可能性に備える
   - レガシーマイグレーション後の `.pi-git/settings.json.bak` もignore対象になる

### Step 8: ドキュメント更新

#### `docs/commands.md`

変更内容:
- `/.pi-git/settings.json` → `pi-git.toml` に全置換 (20箇所程度)
- 設定ファイルセクションの例をTOML形式に更新
- gitignore推奨事項をTOMLファイル向けに更新
- **新規**: TOMLコメント消失に関する注意書きを追加

設定ファイルセクションの更新イメージ:

```markdown
### Local Config

Path: `<git-repo-root>/pi-git.toml`

Project-specific overrides in TOML format. Created automatically on the first
`/git-config` write inside a git repository when neither global nor local
config exists yet. When a legacy `.pi-git/settings.json` is detected, it is
automatically migrated to `pi-git.toml` and renamed to `.bak`.

Example:
\`\`\`toml
# pi-git local configuration
lang = "ja"
auto_agg_commit = true
analysis_model = "anthropic/claude-3-5-sonnet-20241022"
\`\`\`

> **Important**: `pi-git.toml` is at the repository root (not in a
> subdirectory). If you prefer not to share your local settings with the team,
> add `pi-git.toml` to your repository's `.gitignore`. To share project
> defaults, commit the file.

> **Note**: Comments in `pi-git.toml` will be removed when saving via
> `/git-config`. Write comments only if you edit the file manually and
> understand that subsequent `/git-config` saves will strip them.
```

gitignore推奨事項の更新:

```diff
-**Recommended:** Add `.pi-git/` to your repository's `.gitignore` if team
-members should not share the same pi-git settings, or commit it if you want
-to share project defaults.
+**Recommended:** Add `pi-git.toml` to your repository's `.gitignore` if team
+members should not share the same pi-git settings, or commit it if you want
+to share project defaults.
```

#### `docs/commands.ja.md`

同上の日本語版対応:

```diff
-**推奨事項:** チームで設定を共有したい場合は `.pi-git/settings.json` を
-コミットしてください。個人ごとに異なる設定にしたい場合は `.pi-git/` を
-`.gitignore` に追加してください。
+**推奨事項:** チームで設定を共有したい場合は `pi-git.toml` を
+コミットしてください。個人ごとに異なる設定にしたい場合は `pi-git.toml` を
+`.gitignore` に追加してください。

+> **注意:** `pi-git.toml` に手動で追加したコメントは、`/git-config` で
+> 保存する際に削除されます。手動編集後に `/git-config` で保存する場合は
+> ご注意ください。
```

#### `README.md` / `README.ja.md`

- パス表記の更新 (各1箇所)

### Step 9: CHANGELOG.md の作成

新規ファイル `CHANGELOG.md` を作成し、本バージョンの変更点とマイグレーション手順を記載する。

```markdown
# Changelog

## [0.1.0] — YYYY-MM-DD

### Breaking Changes

- Local settings are now stored in `pi-git.toml` (TOML format) at the
  repository root, instead of `.pi-git/settings.json` (JSON format).

### Migration Guide

If you have an existing `.pi-git/settings.json`, it will be **automatically
migrated** to `pi-git.toml` on the next `/git-config` or `/git-auto-agg-commit`
command. The old file will be renamed to `.pi-git/settings.json.bak`.

#### Manual migration (if automatic migration fails)

1. Open your `.pi-git/settings.json` and note the values.
2. Create `pi-git.toml` at the repository root with the same values in TOML
   format:
   \`\`\`toml
   lang = "ja"
   auto_agg_commit = true
   \`\`\`
3. Delete or rename `.pi-git/settings.json`.

#### .gitignore update

- Replace `.pi-git/` with `pi-git.toml` in your `.gitignore` if you had
  `.pi-git/` listed to keep settings private.
- If you were sharing `.pi-git/settings.json`, commit `pi-git.toml` instead.

### Added

- Automatic migration from legacy `.pi-git/settings.json` to `pi-git.toml`.

### Changed

- Local settings format changed from JSON to TOML.
- Local settings file location changed from `.pi-git/settings.json` to
  `pi-git.toml` (repository root).
```

---

## TOMLフォーマットの例

```toml
# pi-git.toml — local pi-git configuration
lang = "ja"
auto_agg_commit = true
analysis_model = "anthropic/claude-3-5-sonnet-20241022"
```

`/git-config` で設定した場合も上記のフォーマットで保存される。

> **Note**: `smol-toml` の `stringify` はコメントを出力しない。手動で追加した `#` コメントは `/git-config` による保存時に失われる。

---

## リスクと注意点

| リスク | 対策 | 解決状況 |
|--------|------|----------|
| **サイレントデータロス**: 既存ユーザーの `.pi-git/settings.json` が無視される | `migrateLegacySettings()` による自動マイグレーション（JSON→TOML書出＋`.bak`リネーム）で対応 | ✅ Step 2d |
| **`.gitignore` 挙動変更**: `pi-git.toml` が untracked file として `git status` に表示される | ドキュメントで明示的に説明。pi-git 自身の `.gitignore` に `pi-git.toml` を追加 | ✅ Step 7, 8 |
| `smol-toml` の `stringify` が `""` や `false` を期待通り出力するか | 明示的なテストケースと合格基準を定義 | ✅ Step 5 |
| TOMLパーサーがJSONと異なる型推論をする可能性 | `PiGitSettings` 型で明示的にアサート。`lang`, `auto_agg_commit`, `analysis_model` はすべてTOMLの基本型（文字列、真偽値）なので問題ない | ✅ |
| グローバル設定 (JSON) とローカル設定 (TOML) でフォーマットが異なることの認知負荷 | ドキュメントに明記。`/git-config` コマンドの使用を推奨 | ✅ Step 8 |
| `smol-toml` が `parse("")` で例外を投げるか | `loadToml()` 内で try-catch しているため安全 | ✅ |
| **TOMLコメント消失**: `/git-config` 保存時に手動コメントが消える | ドキュメントに注意書きを追加 | ✅ Step 8 |
| マイグレーション中のファイルシステムエラー（権限不足など） | try-catch でサイレントに無視。次回呼び出し時に再試行 | ✅ Step 2d |

---

## Implementation Order

1. **Step 1**: `npm install smol-toml` — 依存追加
2. **Step 2**: `src/utils/settings.ts` の改修 — コアロジック + 自動マイグレーション
3. **Step 3**: `src/commands/config.ts` のコメント更新
4. **Step 5**: TOML round-trip 手動テスト
5. **Step 6**: `npm run build` でコンパイル確認
6. **Step 7**: `.gitignore` の更新
7. **Step 8**: ドキュメント更新
8. **Step 9**: `CHANGELOG.md` 作成

---

## Files NOT to Change (確認済み)

| ファイル | 理由 |
|----------|------|
| `src/core/*.ts` | 設定ファイルパスを直接参照していない |
| `src/utils/footer-manager.ts` | settings API経由 |
| `src/utils/diagnostics.ts` | settings API経由 |
| `src/utils/lang.ts` | settings API経由 |
| `src/i18n/messages.ts` | `settings.json` の文字列リテラルを含まない |
| `dist/*` | `tsc` ビルドで自動再生成（JSDocコメント含む `.d.ts` も新しいパス表記になる） |
