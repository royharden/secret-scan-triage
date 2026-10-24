// Test helpers. Token-shaped values are ALWAYS assembled at run time from split parts plus seeded random bodies;
// no complete valid-looking token literal appears in source.

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const ALNUM = UPPER + LOWER + DIGITS;
export const HEX = '0123456789abcdef';

export function randomChars(r: () => number, n: number, alphabet: string): string {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

/** Random alnum body that is guaranteed to contain upper, lower and digit characters. */
export function mixedBody(r: () => number, n: number): string {
  const body = randomChars(r, n - 3, ALNUM);
  return body + randomChars(r, 1, UPPER) + randomChars(r, 1, LOWER) + randomChars(r, 1, DIGITS);
}

export function fakeGithubClassic(r: () => number): string {
  return ['gh', 'p_'].join('') + mixedBody(r, 36);
}

export function fakeGithubFineGrained(r: () => number): string {
  return ['github', '_pat_'].join('') + mixedBody(r, 82);
}

export function fakeAwsKeyId(r: () => number): string {
  return ['AK', 'IA'].join('') + randomChars(r, 12, UPPER + DIGITS) + randomChars(r, 2, DIGITS) + randomChars(r, 2, UPPER);
}

/** A generic high-entropy token with no provider prefix. */
export function fakeGenericToken(r: () => number, n = 40): string {
  return mixedBody(r, n);
}

/** Every 6-character substring of v. */
export function grams6(v: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= v.length; i++) out.push(v.slice(i, i + 6));
  return out;
}

/** Does `text` contain any 6-gram of `value` (or the whole value if shorter than 6)? */
export function containsRawMaterial(text: string, value: string): boolean {
  if (value.length < 6) return text.includes(value);
  return grams6(value).some((g) => text.includes(g));
}

/** Walk an object graph (objects, arrays, Map, Set, typed arrays) collecting strings and primitive kinds. */
export function walk(root: unknown): { strings: string[]; kinds: Set<string> } {
  const strings: string[] = [];
  const kinds = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    const t = typeof v;
    if (t === 'string') {
      strings.push(v as string);
      kinds.add('string');
      return;
    }
    if (t === 'number' || t === 'boolean' || t === 'bigint') {
      kinds.add(t);
      return;
    }
    if (t === 'function') {
      kinds.add('function');
      return;
    }
    if (t !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      kinds.add('typedarray');
      return;
    }
    if (v instanceof Map) {
      for (const [k, val] of v) {
        visit(k);
        visit(val);
      }
      return;
    }
    if (v instanceof Set) {
      for (const val of v) visit(val);
      return;
    }
    for (const k of Object.keys(v as object)) {
      visit((v as Record<string, unknown>)[k]);
    }
  };
  visit(root);
  return { strings, kinds };
}
