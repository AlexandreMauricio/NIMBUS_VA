/**
 * The string-matching rules NIMBUS uses to compare a configured pattern
 * against something observed — an executable name, a window title, a
 * folder path.
 *
 * Extracted from triggerMatcher so Activity detection matches exactly
 * the way Routine triggers do: a user who has learned that
 * "steam.exe, epicgameslauncher.exe" means "either of these" in a
 * trigger should not find that the same text behaves differently in an
 * activity mapping. One implementation is the only way to keep that
 * promise.
 */

export type StringMatchMode = "exact" | "contains";

/** Case-insensitive; "contains" is a substring test, not a pattern language. */
export function matchString(value: string, pattern: string, mode: StringMatchMode): boolean {
  const a = value.toLowerCase();
  const b = pattern.toLowerCase();
  return mode === "exact" ? a === b : a.includes(b);
}

/**
 * A configured field can hold several comma-separated alternatives
 * (e.g. "skillcert,nowuniversity"), so one rule can cover several
 * apps/sites without duplicating it — matches if `value` matches any.
 *
 * A plain single pattern behaves exactly as it reads: splitting
 * "skillcert" on "," just yields `["skillcert"]`. Empty alternatives
 * from stray commas or whitespace are dropped rather than matching
 * everything, which is the difference between a typo being harmless and
 * a rule that fires on literally any input.
 */
export function matchAnyPattern(value: string, patternField: string, mode: StringMatchMode): boolean {
  return splitPatterns(patternField).some((pattern) => matchString(value, pattern, mode));
}

/** The individual alternatives in a comma-separated field, cleaned of blanks. */
export function splitPatterns(patternField: string): string[] {
  return patternField
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
