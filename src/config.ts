import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

// Known TOML keys (snake_case as they appear in the file)
const KNOWN_KEYS = new Set(["lang", "no_body", "commit_every_turn"]);

/**
 * Language configuration for commit messages.
 */
export interface PiGitConfig {
	/** Language for the commit message (subject and body). `"ja"` → Japanese, anything else → English */
	lang: string;
	/** When `true`, the commit message is generated without a body (subject-only). */
	noBody?: boolean;
	/** When `true`, automatically commit at every `agent_end` event. */
	commitEveryTurn?: boolean;
}

const DEFAULT_CONFIG: PiGitConfig = { lang: "en", noBody: false, commitEveryTurn: false };

/**
 * Load `.pi-git/config.toml` from the project root.
 *
 * Returns default config (English body) when the file is missing or unreadable.
 */
export function loadConfig(cwd: string): PiGitConfig {
	try {
		const configPath = join(cwd, ".pi-git", "config.toml");
		const raw = readFileSync(configPath, "utf-8");
		const parsed = parse(raw) as Record<string, unknown>;

		// Warn about unknown (possibly misspelled) keys
		const unknownKeys = Object.keys(parsed).filter((k) => !KNOWN_KEYS.has(k));
		if (unknownKeys.length > 0) {
			console.warn(
				`[pi-git] Unknown config key(s): ${unknownKeys.join(", ")}. ` +
					`Valid keys: ${[...KNOWN_KEYS].join(", ")}`,
			);
		}

		const lang = typeof parsed.lang === "string" && parsed.lang.trim().length > 0
			? parsed.lang.trim()
			: DEFAULT_CONFIG.lang;

		const noBody = typeof parsed.no_body === "boolean"
			? parsed.no_body
			: DEFAULT_CONFIG.noBody;

		const commitEveryTurn = typeof parsed.commit_every_turn === "boolean"
			? parsed.commit_every_turn
			: DEFAULT_CONFIG.commitEveryTurn;

		return { lang, noBody, commitEveryTurn };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Returns `true` when the commit message should be written in Japanese.
 */
export function isJapanese(config: PiGitConfig): boolean {
	return config.lang === "ja";
}

/**
 * Returns `true` when the commit message should omit the body.
 */
export function hasNoBody(config: PiGitConfig): boolean {
	return config.noBody === true;
}
