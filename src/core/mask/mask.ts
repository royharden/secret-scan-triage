// Shape-preserving value mask. A provider prefix is kept only if it is on the fixed list (config/prefixes.json) and
// only at the start of the value; every other character becomes '*'. Output length equals input length.
import { unsafeMarkSafe } from '../safe.ts';
import type { SafeText } from '../safe.ts';
import { MASK_CHAR } from './leakGuard.ts';

/**
 * Masked characters required after a kept prefix. If fewer would remain, the prefix is masked too (keeping it would
 * reveal most of a short value).
 */
export const MIN_MASKED_AFTER_PREFIX = 4;

/**
 * One entry of config/prefixes.json. `length` / `minLength` / `maxLength` refer to the WHOLE value including the
 * prefix. `charset` is a RegExp character-class body (e.g. "A-Z0-9") that every character after the prefix must
 * match. Used by S-R3 (provider_format_exact) via matchProviderFormat.
 */
export interface PrefixSpec {
  prefix: string;
  provider?: string;
  length?: number;
  minLength?: number;
  maxLength?: number;
  charset?: string;
}

function isPosInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

/**
 * Validate config/prefixes.json. Accepts `{ "prefixes": [...] }` (the shipped shape) or a bare array.
 * Throws Error on invalid input (message names the entry index only).
 */
export function loadPrefixConfig(json: unknown): PrefixSpec[] {
  const list: unknown =
    Array.isArray(json) ? json : json !== null && typeof json === 'object' ? (json as { prefixes?: unknown }).prefixes : undefined;
  if (!Array.isArray(list)) throw new Error('prefixes config: expected an array or { prefixes: [...] }');
  const out: PrefixSpec[] = [];
  const seen = new Set<string>();
  list.forEach((entry: unknown, i: number) => {
    if (entry === null || typeof entry !== 'object') throw new Error(`prefixes config: entry ${i} is not an object`);
    const e = entry as Record<string, unknown>;
    const prefix = e.prefix;
    if (typeof prefix !== 'string' || prefix.length === 0 || /\s/.test(prefix)) {
      throw new Error(`prefixes config: entry ${i} has an invalid prefix`);
    }
    if (seen.has(prefix)) throw new Error(`prefixes config: entry ${i} duplicates an earlier prefix`);
    seen.add(prefix);
    const spec: PrefixSpec = { prefix };
    if (e.provider !== undefined) {
      if (typeof e.provider !== 'string') throw new Error(`prefixes config: entry ${i} provider must be a string`);
      spec.provider = e.provider;
    }
    for (const k of ['length', 'minLength', 'maxLength'] as const) {
      if (e[k] === undefined) continue;
      const v = e[k];
      if (!isPosInt(v) || v <= prefix.length) throw new Error(`prefixes config: entry ${i} ${k} must exceed the prefix length`);
      spec[k] = v;
    }
    if (spec.minLength !== undefined && spec.maxLength !== undefined && spec.minLength > spec.maxLength) {
      throw new Error(`prefixes config: entry ${i} minLength > maxLength`);
    }
    if (e.charset !== undefined) {
      if (typeof e.charset !== 'string' || e.charset.length === 0) {
        throw new Error(`prefixes config: entry ${i} charset must be a non-empty string`);
      }
      try {
        new RegExp(`^[${e.charset}]+$`);
      } catch {
        throw new Error(`prefixes config: entry ${i} charset is not a valid character class`);
      }
      spec.charset = e.charset;
    }
    out.push(spec);
  });
  return out;
}

/** Prefix strings for maskValue / buildReportMatcher. */
export function prefixStrings(specs: readonly PrefixSpec[]): string[] {
  return specs.map((s) => s.prefix);
}

/** Longest listed prefix at the START of raw, if enough characters remain to mask. */
export function keptPrefixFor(raw: string, prefixes: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const p of prefixes) {
    if (typeof p !== 'string' || p.length === 0) continue;
    if (raw.length - p.length < MIN_MASKED_AFTER_PREFIX) continue;
    if (!raw.startsWith(p)) continue;
    if (best === undefined || p.length > best.length) best = p;
  }
  return best;
}

/** Shape-preserving mask: `prefix + '*' * (len - prefixLen)` or all '*'. */
export function maskValue(raw: string, prefixes: string[]): { masked: SafeText; keptPrefix?: string } {
  const value = typeof raw === 'string' ? raw : '';
  const kept = keptPrefixFor(value, prefixes);
  if (kept === undefined) return { masked: unsafeMarkSafe(MASK_CHAR.repeat(value.length)) };
  return { masked: unsafeMarkSafe(kept + MASK_CHAR.repeat(value.length - kept.length)), keptPrefix: kept };
}

const charsetRe = new Map<string, RegExp>();

function charsetRegExp(charset: string): RegExp {
  let re = charsetRe.get(charset);
  if (re === undefined) {
    re = new RegExp(`^[${charset}]+$`);
    charsetRe.set(charset, re);
  }
  return re;
}

/** S-R3 helper: the spec whose prefix, length bounds and charset the value matches exactly (longest prefix wins). */
export function matchProviderFormat(value: string, specs: readonly PrefixSpec[]): PrefixSpec | undefined {
  if (typeof value !== 'string') return undefined;
  let best: PrefixSpec | undefined;
  for (const s of specs) {
    if (!value.startsWith(s.prefix)) continue;
    if (s.length !== undefined && value.length !== s.length) continue;
    if (s.minLength !== undefined && value.length < s.minLength) continue;
    if (s.maxLength !== undefined && value.length > s.maxLength) continue;
    const rest = value.slice(s.prefix.length);
    if (rest.length === 0) continue;
    if (s.charset !== undefined && !charsetRegExp(s.charset).test(rest)) continue;
    if (best === undefined || s.prefix.length > best.prefix.length) best = s;
  }
  return best;
}

/**
 * Basename (text after the last '/' or backslash) of a path that has ALREADY passed the leak guard — in practice
 * Finding.path, which runPipeline guard-checks and masks (or withholds) before it builds the Finding. Splitting at a
 * separator cannot create a leak: every n-gram of the basename is an n-gram of the path, and both separators are non-word
 * characters, so token boundaries (short values, kept-prefix positions) are unchanged. Brands the result without a
 * second check; every outbound use still goes through serializeSafe, which re-checks the whole payload.
 * Used by judge/views.ts (MaskedView.basename) so that unsafeMarkSafe stays inside mask/.
 */
export function safeBasename(path: SafeText | string): SafeText {
  const p = typeof path === 'string' ? path : '';
  const parts = p.split(/[\\/]/);
  return unsafeMarkSafe(parts[parts.length - 1] ?? '');
}
