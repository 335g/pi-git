{
  "id": "c21ffe5b",
  "title": "[Bug] agg-commit.ts: setRunning が try/finally の外 → 失敗時に clearRunning されずフッター固化",
  "tags": [
    "bug",
    "pi-git"
  ],
  "status": "open",
  "created_at": "2026-06-06T09:19:33.036Z"
}

## 場所
`src/commands/agg-commit.ts:83`

## 問題
```ts
await footerManager.setRunning("agg-commit", "prepare", runLang);  // ← try の外

try {
    // ... commit logic
} finally {
    await footerManager.clearRunning();
}
```
`setRunning()` が失敗すると `clearRunning()` が呼ばれず、`footerManager.running` が `true` のままになる。以降の agg-commit / auto-commit がすべてブロックされ、セッション再起動まで復旧しない。

## 修正案
`setRunning` を `try` ブロック内に移動する。または失敗時に `clearRunning()` を呼ぶ独立した try/catch で包む。
