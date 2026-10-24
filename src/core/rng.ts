// Seeded, deterministic PRNG (mulberry32) plus small helpers. Pure: no DOM, no Node APIs.
// Used by the synthetic generator (synth/) and available to evalkit and the scripted mock judge.
// Not cryptographic. Never use for salts, ids or anything security-relevant (use crypto.getRandomValues).

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, maxExclusive). Throws if the range is empty. */
  int(min: number, maxExclusive: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates shuffle of a copy; the input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct elements (without replacement), in random order. */
  sample<T>(items: readonly T[], count: number): T[];
  /** A string of `length` characters drawn uniformly from `alphabet`. */
  chars(alphabet: string, length: number): string;
  /** An independent child stream derived from this stream's seed and a label (does not advance this stream). */
  fork(label: string): Rng;
  /** The 32-bit seed this stream was created with. */
  readonly seed: number;
}

/** FNV-1a 32-bit hash of a string; used to derive child seeds from labels. */
export function hashString32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: number): Rng {
  if (!Number.isFinite(seed)) throw new Error('createRng: seed must be a finite number');
  const s = (Math.trunc(seed) >>> 0);
  const nextFn = mulberry32(s);

  const rng: Rng = {
    seed: s,
    next: nextFn,
    int(min: number, maxExclusive: number): number {
      const lo = Math.ceil(min);
      const hi = Math.floor(maxExclusive);
      if (!(hi > lo)) throw new Error('Rng.int: empty range');
      return lo + Math.floor(nextFn() * (hi - lo));
    },
    chance(p: number): boolean {
      return nextFn() < p;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('Rng.pick: empty array');
      return items[Math.floor(nextFn() * items.length)] as T;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(nextFn() * (i + 1));
        const tmp = out[i] as T;
        out[i] = out[j] as T;
        out[j] = tmp;
      }
      return out;
    },
    sample<T>(items: readonly T[], count: number): T[] {
      if (count > items.length) throw new Error('Rng.sample: count exceeds population');
      return rng.shuffle(items).slice(0, count);
    },
    chars(alphabet: string, length: number): string {
      if (alphabet.length === 0) throw new Error('Rng.chars: empty alphabet');
      let out = '';
      for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(nextFn() * alphabet.length));
      return out;
    },
    fork(label: string): Rng {
      return createRng((hashString32(label) ^ Math.imul(s, 0x9e3779b1)) >>> 0);
    },
  };
  return rng;
}
