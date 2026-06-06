{
  "id": "b8d7dadf",
  "title": "[Blocker] agent_end ハンドラーの未処理 Promise Rejection を修正",
  "tags": [
    "bug",
    "pi-git"
  ],
  "status": "completed",
  "created_at": "2026-06-06T03:45:20.371Z",
  "assigned_to_session": "019e9c25-eb1e-7bf8-8dab-245fcd5864f4"
}

## 場所
`src/index.ts:47-49`

## 問題
`pi.on("agent_end", ...)` 内で `handleAutoCommit` を `await` しているが `try/catch` がない。
`stageFiles` が `GitError` を投げると未処理の Promise Rejection となり、フレームワークのイベントループを破壊する可能性がある。
同様の問題が `session_start` ハンドラー (line 24) にも存在する。

## 修正内容
両ハンドラーを `try/catch` で包み、エラーをサイレントに握り潰す実装を適用。修正ファイル: `src/index.ts`。

## レビュー結果
- 2名のフレッシュコンテキストレビュワーによる確認済み
- 修正は適切・副作用なし
- コードベース全体の監査で追加の類似問題3件を発見（別TODO化推奨）
