// Worker-to-page transport for the SESSION-ONLY guard. Never write this snapshot to a store, log or export.
// Only numbers, typed hash arrays and configured-prefix indices cross the worker boundary; no raw values or functions.
import type { LeakGuard } from '../safe.ts';
import { GRAM_LENGTH, createIndexedLeakGuard } from './leakGuard.ts';
import type { IndexedLeakGuard } from './leakGuard.ts';
import { hashLaneA, hashLaneB } from './leakIndex.ts';
import type { LeakIndex } from './leakIndex.ts';

const VERSION = 1;
// Refuse resource exhaustion rather than weaken masking. This is a transport bound, not a claim of capacity.
export const MAX_SNAPSHOT_PAIRS = 4_000_000;
export interface GuardSnapshot {
  version: 1;
  key: Uint32Array;
  grams: Uint32Array;
  shorts: Uint32Array;
  shortLengths: number[];
  prefixIndices: number[];
  valueCount: number;
}

function fail(): never { throw new Error(''); }
function uint(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff;
}
function flatten(table: Map<number, number | number[]>): Uint32Array {
  let pairs = 0;
  for (const b of table.values()) pairs += typeof b === 'number' ? 1 : b.length;
  if (pairs > MAX_SNAPSHOT_PAIRS) fail();
  const out = new Uint32Array(pairs * 2);
  let i = 0;
  for (const [a, bs] of table) {
    for (const b of typeof bs === 'number' ? [bs] : bs) {
      if (!uint(a) || !uint(b)) fail();
      out[i++] = a; out[i++] = b;
    }
  }
  return out;
}

/** The guard must be the locally built hashed guard. Prefix order comes from the shared validated config. */
export function snapshotGuard(guard: LeakGuard, configuredPrefixes: readonly string[]): GuardSnapshot {
  const indexed = guard as IndexedLeakGuard;
  const index = indexed.lookup as LeakIndex | undefined;
  if (!guard.ready || !index || !(index.grams instanceof Map) || !(index.shorts instanceof Map)) fail();
  const prefixIndices = indexed.keptPrefixes.map((p) => {
    const i = configuredPrefixes.indexOf(p);
    if (i < 0) fail();
    return i;
  });
  const snapshot: GuardSnapshot = {
    version: VERSION, key: new Uint32Array(index.key), grams: flatten(index.grams), shorts: flatten(index.shorts),
    shortLengths: [...index.shortLengths], prefixIndices, valueCount: index.valueCount,
  };
  // Validate the exact same shape the receiving page will accept.
  restoreGuard(snapshot, configuredPrefixes);
  return snapshot;
}

function hashTable(pairs: Uint32Array): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (let i = 0; i < pairs.length; i += 2) {
    let bucket = out.get(pairs[i]);
    if (!bucket) { bucket = new Set(); out.set(pairs[i], bucket); }
    bucket.add(pairs[i + 1]);
  }
  return out;
}

/** Fail closed on malformed/version-skewed snapshots. Reconstruct functions locally; clone key/hash data. */
export function restoreGuard(value: unknown, configuredPrefixes: readonly string[]): LeakGuard {
  if (!value || typeof value !== 'object') fail();
  const s = value as GuardSnapshot;
  const keys = Object.keys(s).sort().join(',');
  if (keys !== 'grams,key,prefixIndices,shortLengths,shorts,valueCount,version' || s.version !== VERSION) fail();
  if (!(s.key instanceof Uint32Array) || s.key.length !== 6) fail();
  for (const table of [s.grams, s.shorts]) {
    if (!(table instanceof Uint32Array) || table.length % 2 !== 0 || table.length / 2 > MAX_SNAPSHOT_PAIRS) fail();
  }
  if (!uint(s.valueCount) || !Array.isArray(s.shortLengths) || s.shortLengths.length >= GRAM_LENGTH) fail();
  if (s.shortLengths.some((n, i, all) => !uint(n) || n < 1 || n >= GRAM_LENGTH || (i > 0 && all[i - 1] >= n))) fail();
  if ((s.shorts.length > 0) !== (s.shortLengths.length > 0)) fail();
  if (!Array.isArray(s.prefixIndices) || s.prefixIndices.length > configuredPrefixes.length) fail();
  if (new Set(s.prefixIndices).size !== s.prefixIndices.length) fail();
  if (s.prefixIndices.some((n) => !uint(n) || n >= configuredPrefixes.length)) fail();
  const prefixes = s.prefixIndices.map((i) => configuredPrefixes[i]);
  if (prefixes.some((p) => typeof p !== 'string' || p.length === 0)) fail();
  const key = new Uint32Array(s.key);
  const grams = hashTable(s.grams);
  const shorts = hashTable(s.shorts);
  const has = (table: Map<number, Set<number>>, text: string, start: number, length: number): boolean => {
    const bucket = table.get(hashLaneA(key, text, start, start + length));
    return bucket !== undefined && bucket.has(hashLaneB(key, text, start, start + length));
  };
  return createIndexedLeakGuard({
    shortLengths: Object.freeze([...s.shortLengths]),
    hasGram: (text, start) => has(grams, text, start, GRAM_LENGTH),
    hasShort: (text, start, length) => has(shorts, text, start, length),
  }, prefixes);
}
