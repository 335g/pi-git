import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const AUTO_AGG_COMMIT_STATUS_KEY = "!pi-git-auto-agg-commit";

/**
 * Update the footer status indicator for auto-agg-commit.
 * Shows [auto-commit ON] when enabled, clears when disabled.
 */
export function updateAutoAggCommitStatus(ui: ExtensionUIContext, enabled: boolean): void {
	if (enabled) {
		ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, "[auto-commit ON]");
	} else {
		ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, undefined);
	}
}
