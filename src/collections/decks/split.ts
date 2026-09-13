/**
 * Splits `total` across keys by weight (largest remainder), giving every
 * key at least one when there's room — how basic lands and energy are
 * shared between colours.
 */
export function splitBasicsByWeight(total: number, weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights);
  if (total <= 0 || !keys.length) return {};
  const sum = keys.reduce((s, k) => s + Math.max(0, weights[k]), 0);
  const shares = keys.map((k) => ({
    k,
    exact: sum > 0 ? (Math.max(0, weights[k]) / sum) * total : total / keys.length,
  }));
  const out: Record<string, number> = {};
  for (const s of shares) out[s.k] = Math.floor(s.exact);
  let left = total - Object.values(out).reduce((a, b) => a + b, 0);
  for (const s of [...shares].sort(
    (a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact))
  )) {
    if (left <= 0) break;
    out[s.k]++;
    left--;
  }
  if (total >= keys.length) {
    for (const k of keys) {
      if (out[k] === 0) {
        const donor = keys.reduce((a, b) => (out[a] >= out[b] ? a : b));
        if (out[donor] > 1) {
          out[donor]--;
          out[k] = 1;
        }
      }
    }
  }
  return out;
}
