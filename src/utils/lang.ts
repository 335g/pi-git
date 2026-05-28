/**
 * Language utilities for i18n support
 */

/**
 * Check if the language is Japanese
 */
export function isJapanese(lang: string): boolean {
  return lang === "ja" || lang === "ja-JP" || lang === "japanese";
}

/**
 * Get localized message based on language
 */
export function localize<T>(lang: string, ja: T, en: T): T {
  return isJapanese(lang) ? ja : en;
}
