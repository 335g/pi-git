# Implementation Plan: Migrate local settings from `.pi-git/settings.json` to `pi-git.toml`

## Overview

- **Goal**: ローカル設定の保存先を `<repo-root>/.pi-git/settings.json` から `<repo-root>/pi-git.toml` に変更する
- **Scope**: ローカル設定のみ。グローバル設定 (`~/.config/pi-git/settings.json`) は現状維持
- **Format change**: JSON → TOML
- **Estimated effort**: 小規模（設定I/Oのコア部分 + ドキュメントパス置換）

> **Note**: 本プロジェクトは v0.0.3 であり、semver メジャーバージョン未満のため破壊的変更は許容範囲。過剰な後方互換対応は行わない。

---

## Impact Analysis

### 影響を受けるファイル

| ファイル | 変更内容 | 重要度 |
|----------|----------|--------|
| `package.json` | TOMLパーサー依存の追加 (`smol-toml`) | 🔴 高 |
| `src/utils/settings.ts` | コアの読み書きロジックを JSON→TOML に変更。レガシー検出時の `console.warn` 追加 | 🔴 高 |
| `src/commands/config.ts` | JSDocコメントのパス表記更新 | 🟡 中 |
| `.gitignore` | `pi-git.toml` をignoreに追加（このリポジトリ自身の開発用） | 🟢 低 |
| `docs/commands.md` | `/.pi-git/settings.json` → `pi-git.toml` に全置換 | 🟡 中 |
| `docs/commands.ja.md` | 同上（日本語版） | 🟡 中 |
| `README.md` / `README.ja.md` | パス表記の更新 (各1箇所) | 🟢 低 |

### 影響を受けないファイル

- `src/commands/auto-agg-commit.ts` — `saveLocalSettings()`, `getLocalSettingsPath()` 経由でアクセス
- `src/core/*` — 設定ファイルパスを直接参照していない
- `src/utils/lang.ts`, `src/utils/diagnostics.ts`, `src/utils/footer-manager.ts` — settings API経由
- `src/i18n/*` — メッセージキーはパスを含まない
- `dist/*` — `tsc` 再実行で自動再生成

---

## Detailed Change Plan

### Step 1: TOMLライブラリの追加

```bash
npm install smol-toml
```

**選択理由**: `smol-toml` は軽量（~3KB）、依存ゼロ、ESMネイティブ、TypeScript型付き。`parse` / `stringify` を named export。

```json
// package.json
{
  "dependencies": {
    "smol-toml": "^1.0.0"
  }
}
```

### Step 2: `src/utils/settings.ts` の変更

#### 2a. 定数の変更

```diff
-const LOCAL_SETTINGS_DIR = ".pi-git";
-const LOCAL_SETTINGS_FILE = "settings.json";
+const LOCAL_SETTINGS_FILE = "pi-git.toml";
+const LEGACY_LOCAL_PATH = join(".pi-git", "settings.json");
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

#### 2d. レガシーファイル検出（`console.warn` のみ）

`loadRaw()` 内で、`pi-git.toml` が未作成かつ `.pi-git/settings.json` が存在する場合に警告を出す。自動マイグレーションは行わない。

```diff
 function loadRaw(cwd?: string): {
   global: PiGitSettings;
   local: PiGitSettings | null;
 } {
   const global = loadJson(GLOBAL_SETTINGS_FILE) ?? {};
   const localPath = getLocalSettingsPath(cwd);
-  const local = localPath ? loadJson(localPath) : null;
+  const local = localPath ? loadToml(localPath) : null;

+  // Detect legacy settings file
+  if (!local && localPath) {
+    try {
+      const repoRoot = execSync("git rev-parse --show-toplevel", {
+        cwd,
+        encoding: "utf-8",
+        stdio: ["pipe", "pipe", "ignore"],
+      }).trim();
+      if (repoRoot) {
+        const legacyPath = join(repoRoot, LEGACY_LOCAL_PATH);
+        if (existsSync(legacyPath)) {
+          console.warn(
+            "[pi-git] Found legacy .pi-git/settings.json. " +
+            "Settings are now read from pi-git.toml. " +
+            "Please migrate your settings manually or create pi-git.toml via /git-config."
+          );
+        }
+      }
+    } catch {
+      // ignore
+    }
+  }

   return { global, local };
 }
```

#### 2e. `saveLocalSettings()` の変更（JSON → TOML書き出し）

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

#### 2f. JSDocコメントの更新

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

### Step 3: `src/commands/config.ts` のJSDocコメント更新

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

### Step 4: `.gitignore` の更新

このリポジトリで `/git-config` を実行すると `pi-git.toml` が作成されるため、開発者個人の設定がコミットされないようignoreに追加する。

```diff
 .pi-git/
+pi-git.toml
 .npmrc
```

### Step 5: ビルド

```bash
npm run build
```

`tsc` でコンパイルエラーがないことを確認。

### Step 6: ドキュメントのパス表記更新

全ドキュメントファイルで `/.pi-git/settings.json` → `pi-git.toml` に置換する。

| ファイル | 置換箇所数（概算） |
|----------|-------------------|
| `docs/commands.md` | ~20箇所 |
| `docs/commands.ja.md` | ~20箇所 |
| `README.md` | 1箇所 |
| `README.ja.md` | 1箇所 |

gitignore 推奨事項も合わせて更新:

```diff
-**Recommended:** Add `.pi-git/` to your repository's `.gitignore`...
+**Recommended:** Add `pi-git.toml` to your repository's `.gitignore`...
```

---

## TOMLフォーマットの例

```toml
lang = "ja"
auto_agg_commit = true
analysis_model = "anthropic/claude-3-5-sonnet-20241022"
```

---

## Implementation Order

1. **Step 1**: `npm install smol-toml`
2. **Step 2**: `src/utils/settings.ts` の改修
3. **Step 3**: `src/commands/config.ts` のコメント更新
4. **Step 4**: `.gitignore` の更新
5. **Step 5**: `npm run build`
6. **Step 6**: ドキュメントパス置換
