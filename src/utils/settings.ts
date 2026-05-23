/**
 * Persistent settings storage for pi-git extension.
 *
 * Settings are stored in ~/.config/pi-git/settings.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PiGitSettings {
	/** Commit message language (e.g., "en", "ja") */
	commitMessageLanguage?: string;
}

const CONFIG_DIR = join(homedir(), ".config", "pi-git");
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

const DEFAULT_SETTINGS: PiGitSettings = {
	commitMessageLanguage: "en",
};

function loadSettingsFromDisk(): PiGitSettings {
	if (!existsSync(SETTINGS_FILE)) {
		return { ...DEFAULT_SETTINGS };
	}
	try {
		const raw = readFileSync(SETTINGS_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Partial<PiGitSettings>;
		return {
			...DEFAULT_SETTINGS,
			...parsed,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

// In-memory cache
let cachedSettings: PiGitSettings | undefined;

export function getSettings(): PiGitSettings {
	if (!cachedSettings) {
		cachedSettings = loadSettingsFromDisk();
	}
	return { ...cachedSettings };
}

export function saveSettings(settings: Partial<PiGitSettings>): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	const current = loadSettingsFromDisk();
	const updated = { ...current, ...settings };
	writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2) + "\n", "utf-8");
	cachedSettings = updated;
}

export function getCommitMessageLanguage(): string {
	return getSettings().commitMessageLanguage || "en";
}

export function setCommitMessageLanguage(lang: string): void {
	saveSettings({ commitMessageLanguage: lang });
}
