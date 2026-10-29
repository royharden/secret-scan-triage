// Leak-guard scanning logic shared by the hashed guard (leakIndex.ts) and the report matcher's self-check
// (reportMatcher.ts). Both use findLeakSpans with the same exemption rule, so a line the matcher accepts is a line
// the guard accepts (given the guard is built from matcher.knownValues() and matcher.keptPrefixes()). The only
// exemption is a listed provider prefix at its kept position. Digests receive the same fail-closed scan as any text.
import { LeakGuardError, unsafeMarkSafe } from '../safe.ts';
import type { Boundary, LeakGuard, SafeText } from '../safe.ts';

/** n-gram length used for "no 6-character substring of a raw value" checks. */
export const GRAM_LENGTH = 6;
/** Every nonempty value shorter than GRAM_LENGTH is checked whole at token boundaries, including length 1 and 2. */
export const MIN_GUARD_VALUE_LENGTH = 1;
export const MASK_CHAR = '*';
const MASK_CODE = 42; // '*'

export interface Span {
  start: number;
  end: number;
}

/** [A-Za-z0-9_] — token-boundary definition used for short values and kept-prefix positions. */
export function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
  );
}

/** True when text[start, end) consists only of the mask character (such n-grams are never indexed). */
export function isAllMask(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (text.charCodeAt(i) !== MASK_CODE) return false;
  return true;
}

/** Whole-value window [start, start+len) is delimited by non-word characters or the text edges. */
export function isBounded(text: string, start: number, len: number): boolean {
  const end = start + len;
  return (
    (start === 0 || !isWordChar(text.charCodeAt(start - 1))) &&
    (end === text.length || !isWordChar(text.charCodeAt(end)))
  );
}

/**
 * Occurrences of a kept provider prefix "at its kept position": preceded by start-of-text or a non-word character
 * and immediately followed by the mask character (i.e. the visible start of a masked value). Only n-grams lying
 * wholly inside such an occurrence are exempt from the guard.
 */
export function keptPrefixSpans(text: string, prefixes: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const p of prefixes) {
    if (typeof p !== 'string' || p.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(p, from);
      if (idx === -1) break;
      const end = idx + p.length;
      if ((idx === 0 || !isWordChar(text.charCodeAt(idx - 1))) && text.charCodeAt(end) === MASK_CODE) {
        spans.push({ start: idx, end });
      }
      from = idx + 1;
    }
  }
  return spans;
}

/** Lookup over the indexed material. Implemented with salted hashes (guard) or raw strings (worker-only matcher). */
export interface LeakLookup {
  /** Is text[start, start+GRAM_LENGTH) an indexed n-gram? */
  hasGram(text: string, start: number): boolean;
  /** Is text[start, start+len) an indexed short whole value? */
  hasShort(text: string, start: number, len: number): boolean;
  /** Distinct lengths of indexed short values (each < GRAM_LENGTH). */
  readonly shortLengths: readonly number[];
}

/** Build "max end of an exempt span starting at or before i" so containment is O(1). */
function exemptCover(n: number, exempt: Span[]): Int32Array | null {
  if (exempt.length === 0) return null;
  const cover = new Int32Array(n + 1);
  for (const s of exempt) if (s.end > cover[s.start]) cover[s.start] = s.end;
  for (let i = 1; i <= n; i++) if (cover[i - 1] > cover[i]) cover[i] = cover[i - 1];
  return cover;
}

/**
 * Every window of `text` that matches indexed material and is not wholly inside a kept-prefix occurrence.
 * n-grams anywhere; all nonempty short values only at token boundaries. `firstOnly` stops at the first hit.
 */
export function findLeakSpans(
  text: string,
  lookup: LeakLookup,
  keptPrefixes: readonly string[],
  firstOnly = false,
): Span[] {
  const hits: Span[] = [];
  const n = text.length;
  const cover = exemptCover(n, keptPrefixSpans(text, keptPrefixes));
  const exempt = (s: number, e: number): boolean => cover !== null && cover[s] >= e;
  for (let i = 0; i + GRAM_LENGTH <= n; i++) {
    if (lookup.hasGram(text, i) && !exempt(i, i + GRAM_LENGTH)) {
      hits.push({ start: i, end: i + GRAM_LENGTH });
      if (firstOnly) return hits;
    }
  }
  for (const len of lookup.shortLengths) {
    for (let i = 0; i + len <= n; i++) {
      if (!isBounded(text, i, len)) continue;
      if (lookup.hasShort(text, i, len) && !exempt(i, i + len)) {
        hits.push({ start: i, end: i + len });
        if (firstOnly) return hits;
      }
    }
  }
  return hits;
}

/** Validate kept prefixes: non-empty, a true prefix of its value, shorter than the value. Returns unique strings. */
export function validKeptPrefixStrings(kept: ReadonlyArray<{ value: string; prefix: string }>): string[] {
  const out = new Set<string>();
  for (const k of kept) {
    if (!k || typeof k.prefix !== 'string' || typeof k.value !== 'string') continue;
    if (k.prefix.length === 0 || k.prefix.length >= k.value.length) continue;
    if (!k.value.startsWith(k.prefix)) continue;
    out.add(k.prefix);
  }
  return [...out].sort();
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** Guard object over a lookup. Fields are plain data (hashes only for the hashed lookup) so tests can inspect them. */
export interface IndexedLeakGuard extends LeakGuard {
  readonly lookup: LeakLookup;
  readonly keptPrefixes: readonly string[];
}

export function createIndexedLeakGuard(
  lookup: LeakLookup,
  keptPrefixes: readonly string[],
): IndexedLeakGuard {
  const prefixes = Object.freeze([...keptPrefixes]);
  const guard: IndexedLeakGuard = {
    ready: true,
    lookup,
    keptPrefixes: prefixes,
    check(text: string, boundary: Boundary, findingId?: string): void {
      if (typeof text !== 'string') {
        throw new LeakGuardError(boundary, { findingId, reason: 'unserializable', showIdInMessage: false });
      }
      if (findLeakSpans(text, lookup, prefixes, true).length === 0) return;
      // Show the id in the (masked) message only if the id itself is clean.
      const showId =
        typeof findingId === 'string' &&
        findingId.length > 0 &&
        findingId.length <= 256 &&
        !hasControlChars(findingId) &&
        findLeakSpans(findingId, lookup, prefixes, true).length === 0;
      throw new LeakGuardError(boundary, { findingId, reason: 'leak', showIdInMessage: showId });
    },
    exemptDigests(_hexes: readonly string[]): number {
      return 0; // Compatibility only: no digest can bypass the strict known-value scan.
    },
  };
  return Object.freeze(guard);
}

/**
 * The guarded SafeText constructor for modules outside mask/ (e.g. model free text, import errors).
 * Runs guard.check and brands the text only if it passes; throws LeakGuardError otherwise.
 */
export function guardedSafeText(text: string, boundary: Boundary, guard: LeakGuard, findingId?: string): SafeText {
  if (!guard || guard.ready !== true) {
    throw new LeakGuardError(boundary, { findingId, reason: 'not_ready' });
  }
  guard.check(text, boundary, findingId);
  return unsafeMarkSafe(text);
}
