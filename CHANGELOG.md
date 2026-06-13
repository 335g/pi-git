# Changelog

## 0.0.6 (2026-06-13)

### Added
- **TurnLog**: Conversation context is automatically accumulated across turns and injected into `/git-agg-commit` AI prompts for higher-quality hunk splitting
- **Batch commit**: `/git-agg-commit` uses TurnLog context to produce multi-hunk commits with better messages
- **Footer status display**: Shows turn accumulation counter with severity levels
- **`--review` flag** on `/git-agg-commit` (interactive hunk review before commit)
- **`isGenericMessage` check** in hunk pipeline (replaces vague messages like "変更を適用" with file-based fallbacks)

### Removed
- **auto-commit**: Per-turn immediate commit and confirmation dialog removed. All committing is now done via `/git-agg-commit`
- **auto-commit settings**: `auto_agg_commit`, `auto_agg_commit_mode`, `batch_warn_turns`, `auto_agg_commit_skip_confirm_*`, `auto_agg_commit_min_*`

### Changed
- `commitHunks` extracted to shared module `commit-hunks.ts`
- `runHunkReview` extracted to `review.ts`
- `isGenericMessage` moved to `commit-message.ts`
- `/git-agg-commit` always uses TurnLog context (falls back to diff-only when TurnLog is empty)

## 0.0.4

### Added
- Initial release with `/git-agg-commit` and `/git-config` commands
