// Report-wide matcher (worker/Node-eval only: it holds raw values). Masks, in any line: every known finding value
// in the report, every 6-gram of one (partial occurrences), short values at token boundaries, and credential-looking
// tokens the scanner did not report (which are then learned for later lines and for the leak guard). The masked
// output is re-verified with the SAME scan the leak guard uses; if it cannot be made clean the line is unmaskable.
import { unsafeMarkSafe } from '../safe.ts';
import type { SafeText } from '../safe.ts';
import {
  GRAM_LENGTH,
  MASK_CHAR,
  MIN_GUARD_VALUE_LENGTH,
  findLeakSpans,
  isAllMask,
  isBounded,
  isWordChar,
} from './leakGuard.ts';
import type { LeakLookup } from './leakGuard.ts';
import type { KeptPrefix } from './leakIndex.ts';
import { keptPrefixFor } from './mask.ts';
import { findCredentialTokens } from './tokens.ts';

/** Lines longer than this are refused outright (unmaskable). Callers pre-truncate display lines (see context/). */
export const MAX_MASKABLE_LINE_CHARS = 20_000;
const MAX_VERIFY_PASSES = 4;

export interface ReportMatcher {
  maskLine(rawLine: string): { text: SafeText } | { unmaskable: true };
  /** Finding values plus every unreported token learned so far (feed to buildLeakGuard). */
  knownValues(): string[];
  /** Kept prefixes for known values (feed to buildLeakGuard so its exemption matches these masks). */
  keptPrefixes(): KeptPrefix[];
  /** Optional: learn unreported tokens from all lines first, so masking is identical regardless of line order. */
  prime(rawLines: readonly string[]): void;
}

export function buildReportMatcher(values: string[], prefixes: string[]): ReportMatcher {
  const prefixList = prefixes.filter((p) => typeof p === 'string' && p.length > 0);
  const valueSet = new Set<string>();
  const grams = new Set<string>();
  const shortByLen = new Map<number, Set<string>>();
  let shortLengths: number[] = [];
  /** First GRAM_LENGTH chars -> values with a kept prefix starting with them. */
  const keptByFirstGram = new Map<string, string[]>();
  const keptByValue = new Map<string, string>();
  const keptPrefixStrings = new Set<string>();
  let keptPrefixArray: string[] = [];

  const lookup: LeakLookup = {
    hasGram: (t, s) => grams.has(t.slice(s, s + GRAM_LENGTH)),
    hasShort: (t, s, len) => shortByLen.get(len)?.has(t.slice(s, s + len)) === true,
    get shortLengths() {
      return shortLengths;
    },
  };

  function addValue(v: string): void {
    if (typeof v !== 'string' || v.length < MIN_GUARD_VALUE_LENGTH || valueSet.has(v)) return;
    valueSet.add(v);
    if (v.length >= GRAM_LENGTH) {
      for (let i = 0; i + GRAM_LENGTH <= v.length; i++) {
        if (!isAllMask(v, i, i + GRAM_LENGTH)) grams.add(v.slice(i, i + GRAM_LENGTH));
      }
    } else {
      let set = shortByLen.get(v.length);
      if (set === undefined) {
        set = new Set<string>();
        shortByLen.set(v.length, set);
        shortLengths = [...shortByLen.keys()].sort((a, b) => a - b);
      }
      set.add(v);
    }
    const kp = keptPrefixFor(v, prefixList);
    if (kp !== undefined && v.length >= GRAM_LENGTH) {
      keptByValue.set(v, kp);
      const first = v.slice(0, GRAM_LENGTH);
      const list = keptByFirstGram.get(first);
      if (list === undefined) keptByFirstGram.set(first, [v]);
      else list.push(v);
      if (!keptPrefixStrings.has(kp)) {
        keptPrefixStrings.add(kp);
        keptPrefixArray = [...keptPrefixStrings].sort();
      }
    }
  }

  for (const v of values) addValue(v);

  function learnTokens(text: string): void {
    for (const t of findCredentialTokens(text)) addValue(t.value);
  }

  function maskLine(rawLine: string): { text: SafeText } | { unmaskable: true } {
    if (typeof rawLine !== 'string' || rawLine.length > MAX_MASKABLE_LINE_CHARS) return { unmaskable: true };
    const n = rawLine.length;
    if (n === 0) return { text: unsafeMarkSafe('') };

    // 1. Learn unreported tokens in this line first, so the gram pass below covers them.
    learnTokens(rawLine);

    // 2. Kept-prefix occurrences of known values (prefix visible only at a token boundary).
    const keep = new Uint8Array(n);
    if (keptByFirstGram.size > 0) {
      for (let i = 0; i + GRAM_LENGTH <= n; i++) {
        const list = keptByFirstGram.get(rawLine.slice(i, i + GRAM_LENGTH));
        if (list === undefined) continue;
        if (i > 0 && isWordChar(rawLine.charCodeAt(i - 1))) continue;
        for (const v of list) {
          if (!rawLine.startsWith(v, i)) continue;
          const kp = keptByValue.get(v);
          if (kp === undefined) continue;
          for (let j = i; j < i + kp.length; j++) keep[j] = 1;
        }
      }
    }

    // 3. Mask every char covered by an indexed n-gram (full and partial value occurrences), except grams wholly
    //    inside a kept prefix; straddling grams mask only their non-prefix chars.
    const mask = new Uint8Array(n);
    const markRange = (s: number, e: number, respectKeep: boolean): void => {
      for (let j = s; j < e; j++) if (!respectKeep || keep[j] === 0) mask[j] = 1;
    };
    const whollyKept = (s: number, e: number): boolean => {
      for (let j = s; j < e; j++) if (keep[j] === 0) return false;
      return true;
    };
    for (let i = 0; i + GRAM_LENGTH <= n; i++) {
      if (grams.has(rawLine.slice(i, i + GRAM_LENGTH)) && !whollyKept(i, i + GRAM_LENGTH)) {
        markRange(i, i + GRAM_LENGTH, true);
      }
    }
    // 4. Short values at token boundaries.
    for (const len of shortLengths) {
      const set = shortByLen.get(len);
      if (set === undefined) continue;
      for (let i = 0; i + len <= n; i++) {
        if (isBounded(rawLine, i, len) && set.has(rawLine.slice(i, i + len)) && !whollyKept(i, i + len)) {
          markRange(i, i + len, true);
        }
      }
    }

    let chars: string[] = [];
    for (let j = 0; j < n; j++) chars.push(mask[j] === 1 ? MASK_CHAR : rawLine[j]);
    let out = chars.join('');

    // 5. Verify with the guard's own scan (same exemption rule). Mask any remaining hit and re-check.
    for (let pass = 0; pass < MAX_VERIFY_PASSES; pass++) {
      learnTokens(out);
      const hits = findLeakSpans(out, lookup, keptPrefixArray, false);
      if (hits.length === 0) return { text: unsafeMarkSafe(out) };
      chars = out.split('');
      for (const h of hits) for (let j = h.start; j < h.end; j++) chars[j] = MASK_CHAR;
      out = chars.join('');
    }
    return findLeakSpans(out, lookup, keptPrefixArray, true).length === 0
      ? { text: unsafeMarkSafe(out) }
      : { unmaskable: true };
  }

  return {
    maskLine,
    knownValues: () => [...valueSet],
    keptPrefixes: () => [...keptByValue].map(([value, prefix]) => ({ value, prefix })),
    prime(rawLines: readonly string[]): void {
      for (const l of rawLines) if (typeof l === 'string' && l.length <= MAX_MASKABLE_LINE_CHARS) learnTokens(l);
    },
  };
}
