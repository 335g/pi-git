import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

/**
 * Language configuration for commit messages.
 */
export interface PiGitConfig {
	/** Language for the commit message (subject and body). `"ja"` → Japanese, anything else → English */
	lang: string;
}

const DEFAULT_CONFIG: PiGitConfig = { lang: "en" };

/**
 * Load `.pi-git/config.toml` from the project root.
 *
 * Returns default config (English body) when the file is missing or unreadable.
 */
export function loadConfig(cwd: string): PiGitConfig {
	try {
		const configPath = join(cwd, ".pi-git", "config.toml");
		const raw = readFileSync(configPath, "utf-8");
		const parsed = parse(raw) as { lang?: string };

		const lang = typeof parsed.lang === "string" && parsed.lang.trim().length > 0
			? parsed.lang.trim()
			: DEFAULT_CONFIG.lang;

		return { lang };
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
