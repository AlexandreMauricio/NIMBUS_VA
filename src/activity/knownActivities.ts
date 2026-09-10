/**
 * Every activity name NIMBUS currently knows about.
 *
 * This is what lets the rest of the UI offer activities as a choice
 * rather than a free-text box. Typing a name a second time to refer to
 * it means a typo silently produces a routine that can never match, and
 * nothing tells you — the string just never equals anything.
 *
 * De-duplicated case-insensitively, since that is how activities are
 * matched, but the first spelling seen is the one kept. Disabled
 * mappings still contribute, so turning one off temporarily doesn't make
 * the routines referring to it look like they point at nothing.
 */
export function knownActivityNames(mappings: { activity: string }[]): string[] {
  const seen = new Map<string, string>();

  for (const mapping of mappings) {
    const trimmed = mapping.activity?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }

  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
