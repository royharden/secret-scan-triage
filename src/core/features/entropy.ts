// Shannon entropy computed in code (never taken from the scanner's reported entropy).

/** Bits per character over Unicode code points. Empty string -> 0. */
export function shannonEntropy(s: string): number {
  if (typeof s !== 'string' || s.length === 0) return 0;
  const counts = new Map<string, number>();
  let total = 0;
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    total++;
  }
  let h = 0;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  // Clamp tiny negative zero / float noise.
  return h <= 0 ? 0 : h;
}
