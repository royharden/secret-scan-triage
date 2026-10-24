// Session-only leak index: salted 64-bit hashes of every 6-gram of each known value (finding values and detected
// unreported tokens), plus whole-value hashes for every nonempty short value's boundary check.
// Stores ONLY numbers (hashes and derived seeds) — no raw
// strings and not the salt itself. The salt is a separate session salt (PLAN P5), never persisted.
//
// The keyed hash is two independently seeded 32-bit murmur3-style mixes (64 bits total). It is synchronous so the
// guard can run inside JSON serialisation; it is NOT a cryptographic MAC. Its job is to avoid keeping raw strings
// in memory structures that outlive the worker and to defeat precomputed tables; the session salt never leaves
// memory. Hash collisions with ordinary text fail closed (the output is blocked and routed to review).
import type { LeakGuard } from '../safe.ts';
import {
  GRAM_LENGTH,
  MIN_GUARD_VALUE_LENGTH,
  createIndexedLeakGuard,
  isAllMask,
  validKeptPrefixStrings,
} from './leakGuard.ts';
import type { LeakLookup } from './leakGuard.ts';

export interface KeptPrefix {
  value: string;
  prefix: string;
}

export const SESSION_SALT_BYTES = 32;
const MIN_SALT_BYTES = 16;

/** Fresh random session salt (crypto.getRandomValues). Keep in memory only. */
export function createSessionSalt(): Uint8Array {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('Web Crypto getRandomValues is unavailable; refusing to build a leak guard.');
  }
  const salt = new Uint8Array(SESSION_SALT_BYTES);
  c.getRandomValues(salt);
  return salt;
}

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function rotl(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function mixBlock(h: number, k: number): number {
  k = Math.imul(k, C1);
  k = rotl(k, 15);
  k = Math.imul(k, C2);
  h ^= k;
  h = rotl(h, 13);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Derived key material: [seedA, keyA0, keyA1, seedB, keyB0, keyB1] as uint32. */
export type HashKey = Uint32Array;

/** Derive six 32-bit key words from the salt (FNV-1a folds with distinct offsets, then fmix). */
export function deriveHashKey(salt: Uint8Array): HashKey {
  if (!(salt instanceof Uint8Array) || salt.length < MIN_SALT_BYTES) {
    throw new Error(`Leak guard session salt must be at least ${MIN_SALT_BYTES} bytes.`);
  }
  const key = new Uint32Array(6);
  for (let j = 0; j < 6; j++) {
    let h = (0x811c9dc5 ^ Math.imul(j + 1, 0x9e3779b9)) >>> 0;
    for (let i = 0; i < salt.length; i++) {
      // Walk the salt forwards for even words, backwards for odd words.
      const b = salt[j % 2 === 0 ? i : salt.length - 1 - i];
      h ^= b;
      h = Math.imul(h, 0x01000193);
    }
    key[j] = fmix(h ^ j);
  }
  return key;
}

/** One keyed 32-bit lane over UTF-16 code units of text[start, end). */
function lane(text: string, start: number, end: number, seed: number, k0: number, k1: number): number {
  let h = seed | 0;
  h = mixBlock(h, k0);
  h = mixBlock(h, k1);
  for (let i = start; i < end; i++) h = mixBlock(h, text.charCodeAt(i));
  h ^= end - start;
  return fmix(h);
}

export function hashLaneA(key: HashKey, text: string, start: number, end: number): number {
  return lane(text, start, end, key[0], key[1], key[2]);
}

export function hashLaneB(key: HashKey, text: string, start: number, end: number): number {
  return lane(text, start, end, key[3], key[4], key[5]);
}

/** 64-bit keyed hash as 16 lowercase hex chars (diagnostics/tests). */
export function keyedHash64Hex(key: HashKey, text: string): string {
  const a = hashLaneA(key, text, 0, text.length);
  const b = hashLaneB(key, text, 0, text.length);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Map laneA -> laneB (or several laneB values on a laneA collision). Numbers only. */
type HashTable = Map<number, number | number[]>;

function tableAdd(t: HashTable, a: number, b: number): boolean {
  const cur = t.get(a);
  if (cur === undefined) {
    t.set(a, b);
    return true;
  }
  if (typeof cur === 'number') {
    if (cur === b) return false;
    t.set(a, [cur, b]);
    return true;
  }
  if (cur.includes(b)) return false;
  cur.push(b);
  return true;
}

function tableHas(t: HashTable, a: number, b: number): boolean {
  const cur = t.get(a);
  if (cur === undefined) return false;
  return typeof cur === 'number' ? cur === b : cur.includes(b);
}

/** The index: derived key words + hash tables. No raw strings, no salt bytes. */
export interface LeakIndex extends LeakLookup {
  readonly key: HashKey;
  readonly grams: HashTable;
  readonly shorts: HashTable;
  readonly shortLengths: number[];
  /** Number of values indexed (for diagnostics). */
  readonly valueCount: number;
}

export function buildLeakIndex(values: readonly string[], salt: Uint8Array): LeakIndex {
  const key = deriveHashKey(salt);
  const grams: HashTable = new Map();
  const shorts: HashTable = new Map();
  const lengths = new Set<number>();
  let valueCount = 0;
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_GUARD_VALUE_LENGTH || seen.has(v)) continue;
    seen.add(v);
    valueCount++;
    if (v.length >= GRAM_LENGTH) {
      for (let i = 0; i + GRAM_LENGTH <= v.length; i++) {
        if (isAllMask(v, i, i + GRAM_LENGTH)) continue;
        tableAdd(grams, hashLaneA(key, v, i, i + GRAM_LENGTH), hashLaneB(key, v, i, i + GRAM_LENGTH));
      }
    } else {
      tableAdd(shorts, hashLaneA(key, v, 0, v.length), hashLaneB(key, v, 0, v.length));
      lengths.add(v.length);
    }
  }
  seen.clear();
  const shortLengths = [...lengths].sort((a, b) => a - b);
  return {
    key,
    grams,
    shorts,
    shortLengths,
    valueCount,
    hasGram(text: string, start: number): boolean {
      const end = start + GRAM_LENGTH;
      const a = hashLaneA(key, text, start, end);
      if (!grams.has(a)) return false;
      return tableHas(grams, a, hashLaneB(key, text, start, end));
    },
    hasShort(text: string, start: number, len: number): boolean {
      const end = start + len;
      const a = hashLaneA(key, text, start, end);
      if (!shorts.has(a)) return false;
      return tableHas(shorts, a, hashLaneB(key, text, start, end));
    },
  };
}

/**
 * Build the session leak guard. `values` = every known finding value AND every detected unreported token (use
 * ReportMatcher.knownValues()); `keptPrefixes` = ReportMatcher.keptPrefixes() so the guard's exemption matches the
 * masks the matcher produced. Raw strings are not retained after this returns (only hashes + kept prefix strings,
 * which are fixed provider prefixes from config/prefixes.json). Digest collisions fail closed.
 */
export function buildLeakGuard(values: string[], keptPrefixes: KeptPrefix[], sessionSalt: Uint8Array): LeakGuard {
  const index = buildLeakIndex(values, sessionSalt);
  return createIndexedLeakGuard(index, validKeptPrefixStrings(keptPrefixes));
}
