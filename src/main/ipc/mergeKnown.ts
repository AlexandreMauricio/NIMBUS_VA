/**
 * Applies a renderer-supplied partial update to a settings group, keeping
 * only fields the group already has and only values of the same kind.
 *
 * The routine and activity handlers validate everything they save; the
 * simpler groups used to spread whatever arrived straight into
 * settings.json. The renderer is NIMBUS's own code, but a bug there (or a
 * stray field) shouldn't be able to write an unknown key or a string
 * where a boolean belongs. null is accepted, since several fields are
 * nullable by design (a manual location, a preferred device).
 */
export function mergeKnown<T extends object>(current: T, partial: unknown): T {
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) return current;
  const out: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in current)) continue;
    const existing = (current as Record<string, unknown>)[key];
    const sameKind =
      value === null ||
      existing === null ||
      (typeof value === typeof existing && Array.isArray(value) === Array.isArray(existing));
    if (sameKind) out[key] = value;
  }
  return out as T;
}
