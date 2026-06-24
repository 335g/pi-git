import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";

/**
 * Result of checking the repository state.
 */
export interface GitStatus {
	hasChanges: boolean;
	raw: string;
}

/**
 * Wrapper around git operations used by the extension.
 *
 * All commands are run via `pi.exec()` so they inherit pi's environment
 * (PATH, SSH keys, git config, etc.).
 */
export class GitOperations {
	constructor(private readonly pi: ExtensionAPI) {}

	/**
	 * Check whether the current directory is inside a git working tree.
	 * Returns `true` on success, `false` if not a git repo.
	 */
	async isInsideGitRepo(): Promise<boolean> {
		const { code } = await this.pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
		return code === 0;
	}

	/**
	 * Run `git status --short` and return whether there are uncommitted changes.
	 */
	async checkStatus(): Promise<GitStatus> {
		const { stdout } = await this.pi.exec("git", ["status", "--short"]);
		const trimmed = stdout.trim();
		return { hasChanges: trimmed.length > 0, raw: trimmed };
	}

	/**
	 * Stage all changes via `git add -A`.
	 */
	async stageAll(): Promise<void> {
		await this.pi.exec("git", ["add", "-A"]);
	}

	/**
	 * Get the stat summary of staged changes (`git diff --cached --stat`).
	 */
	async getStagedStat(): Promise<string> {
		const { stdout } = await this.pi.exec("git", ["diff", "--cached", "--stat"]);
		return stdout.trim();
	}

	/**
	 * Get the full diff of staged changes (`git diff --cached`).
	 */
	async getStagedDiff(): Promise<string> {
		const { stdout } = await this.pi.exec("git", ["diff", "--cached"]);
		return stdout.trim();
	}

	/**
	 * Get the name-status of staged changes (`git diff --cached --name-status`).
	 */
	async getStagedNameStatus(): Promise<string> {
		const { stdout } = await this.pi.exec("git", ["diff", "--cached", "--name-status"]);
		return stdout.trim();
	}

	/**
	 * Check whether a merge conflict is in progress.
	 * Returns `true` if the index is locked (conflict markers present, etc.)
	 */
	async hasMergeConflict(): Promise<boolean> {
		// If a merge is in progress, `git diff --cached` may fail or
		// `git ls-files --unmerged` returns non-empty output.
		const { stdout } = await this.pi.exec("git", ["ls-files", "--unmerged"]);
		return stdout.trim().length > 0;
	}

	/**
	 * Execute the commit with the given message.
	 * Returns the raw stdout output of `git commit`.
	 */
	async commit(message: string): Promise<ExecResult> {
		return await this.pi.exec("git", ["commit", "-m", message]);
	}
}
