// Deterministic signals S-R1..S-R5, S-F1..S-F11 (Claude plan §2.4, merged PLAN §0 P7).
// Pure TS: runs inside the parse worker (or the Node eval process) on the RAW candidate, before raw values are released.
// Every signal's evidence is a CitedPointer bound to the finding's own span (trap T17). Scanner entropy is never read here.
import type { CharClass, Features, RawCandidate, Signal, SignalId } from '../finding.ts';
import { evalRealSignals } from './real.ts';
import { evalSentinelSignals } from './sentinels.ts';
import { evalReferenceSignals } from './references.ts';
import { buildSpanContext, evalShapeSignals } from './shapes.ts';
import type { SignalHit } from './shapes.ts';
import { evalPathSignals } from './path.ts';
import { loadPrefixConfig } from '../mask/mask.ts';
import type { PrefixSpec } from '../mask/mask.ts';

export interface SignalDef {
  id: SignalId;
  name: string;
  direction: 'real' | 'fp';
  strength: 'decisive' | 'strong' | 'weak';
  downgradeOnly?: boolean;
}

/**
 * The signal table is a safety invariant (e.g. path class may only downgrade). `config/signals.json` must restate it
 * exactly; `loadSignalConfig` rejects any drift rather than letting config promote a weak signal.
 */
export const CANONICAL_SIGNALS: ReadonlyArray<SignalDef> = Object.freeze([
  { id: 'S-R1', name: 'trufflehog_verified', direction: 'real', strength: 'decisive' },
  { id: 'S-R2', name: 'full_pem_body', direction: 'real', strength: 'strong' },
  { id: 'S-R3', name: 'provider_format_exact', direction: 'real', strength: 'strong' },
  { id: 'S-R4', name: 'high_precision_rule', direction: 'real', strength: 'strong' },
  { id: 'S-R5', name: 'keyword_assignment_high_entropy', direction: 'real', strength: 'strong' },
  { id: 'S-F1', name: 'documented_sentinel', direction: 'fp', strength: 'decisive' },
  { id: 'S-F2', name: 'reference_not_literal', direction: 'fp', strength: 'decisive' },
  { id: 'S-F3', name: 'lockfile_integrity', direction: 'fp', strength: 'decisive' },
  { id: 'S-F4', name: 'pem_elided', direction: 'fp', strength: 'decisive' },
  { id: 'S-F5', name: 'placeholder_word', direction: 'fp', strength: 'strong' },
  { id: 'S-F6', name: 'uuid_or_commit_shape', direction: 'fp', strength: 'strong' },
  { id: 'S-F7', name: 'data_uri', direction: 'fp', strength: 'strong' },
  { id: 'S-F8', name: 'self_named', direction: 'fp', strength: 'strong' },
  { id: 'S-F9', name: 'low_entropy_for_class', direction: 'fp', strength: 'weak' },
  { id: 'S-F10', name: 'identifier_shape', direction: 'fp', strength: 'weak' },
  { id: 'S-F11', name: 'path_test_fixture_docs', direction: 'fp', strength: 'weak', downgradeOnly: true },
] as SignalDef[]);

export const SIGNAL_ORDER: ReadonlyArray<SignalId> = CANONICAL_SIGNALS.map((d) => d.id);

const CHAR_CLASSES: ReadonlyArray<CharClass> = ['hex', 'base64', 'base64url', 'alnum', 'digits', 'mixed', 'pem'];

export interface SignalConfig {
  version: string;
  defs: Readonly<Record<SignalId, SignalDef>>;
  /** Shannon bits/char per char class; S-R5 needs entropy >= threshold, S-F9 fires below it. */
  entropyThresholds: Readonly<Record<CharClass, number>>;
  /** Effective threshold = min(class threshold, factor * log2(length)) so short values are not all "low entropy". */
  entropyLengthFactor: number;
  credentialKeywords: ReadonlyArray<string>;
  placeholderWords: ReadonlyArray<string>;
  placeholderPatterns: ReadonlyArray<RegExp>;
  identifierWords: ReadonlySet<string>;
  /** Assembled sentinel value -> sentinel id. Values are stored split in config and joined only here, at load. */
  sentinels: ReadonlyMap<string, string>;
  /**
   * S-R3 provider formats: the validated config/prefixes.json specs (prefix + length bounds + charset), the same list
   * the mask keeps prefixes from. Matched with matchProviderFormat (mask/mask.ts). There is no second format list.
   */
  providerFormats: ReadonlyArray<PrefixSpec>;
  pem: { minBodyChars: number; elisionMarkers: ReadonlyArray<string> };
  lockfileBasenames: ReadonlyArray<string>;
  /** Lower-cased rule ids from config/high-precision-rules.json. */
  highPrecisionRules: ReadonlyArray<string>;
}

export class SignalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalConfigError';
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function strArray(x: unknown, field: string): string[] {
  if (!Array.isArray(x) || !x.every((s) => typeof s === 'string' && s.length > 0)) {
    throw new SignalConfigError(`signals config: ${field} must be an array of non-empty strings`);
  }
  return x as string[];
}

function compile(pattern: string, field: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    throw new SignalConfigError(`signals config: ${field} has an invalid pattern`);
  }
}

/** Parses config/high-precision-rules.json (`{"rules": [...]}`) into lower-cased rule ids. */
export function loadHighPrecisionRules(json: unknown): string[] {
  if (!isObj(json)) throw new SignalConfigError('high-precision rules: expected an object');
  return strArray(json.rules, 'rules').map((r) => r.toLowerCase());
}

/**
 * Validates config/signals.json + config/high-precision-rules.json + config/prefixes.json (the single source of S-R3
 * provider formats; parsed with loadPrefixConfig). Throws SignalConfigError on any problem.
 */
export function loadSignalConfig(signalsJson: unknown, highPrecisionJson: unknown, prefixesJson: unknown): SignalConfig {
  if (!isObj(signalsJson)) throw new SignalConfigError('signals config: expected an object');
  const j = signalsJson;
  if (typeof j.version !== 'string') throw new SignalConfigError('signals config: version must be a string');

  // Signal table must match the canonical table exactly.
  if (!Array.isArray(j.signals) || j.signals.length !== CANONICAL_SIGNALS.length) {
    throw new SignalConfigError('signals config: signals must list all 16 signal ids');
  }
  const defs = {} as Record<SignalId, SignalDef>;
  for (const canon of CANONICAL_SIGNALS) {
    const entry = (j.signals as unknown[]).find((s) => isObj(s) && s.id === canon.id);
    if (!isObj(entry)) throw new SignalConfigError(`signals config: missing ${canon.id}`);
    if (entry.direction !== canon.direction || entry.strength !== canon.strength
      || entry.name !== canon.name || Boolean(entry.downgradeOnly) !== Boolean(canon.downgradeOnly)) {
      throw new SignalConfigError(`signals config: ${canon.id} differs from the canonical signal table`);
    }
    defs[canon.id] = Object.freeze({ ...canon });
  }

  if (!isObj(j.entropy_thresholds)) throw new SignalConfigError('signals config: entropy_thresholds must be an object');
  const thr = {} as Record<CharClass, number>;
  for (const c of CHAR_CLASSES) {
    const v = j.entropy_thresholds[c];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 8) {
      throw new SignalConfigError(`signals config: entropy_thresholds.${c} must be a finite number in [0, 8]`);
    }
    thr[c] = v;
  }
  const factor = j.entropy_length_factor;
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0 || factor > 1) {
    throw new SignalConfigError('signals config: entropy_length_factor must be in (0, 1]');
  }

  const sentinels = new Map<string, string>();
  if (!Array.isArray(j.sentinels)) throw new SignalConfigError('signals config: sentinels must be an array');
  for (const s of j.sentinels as unknown[]) {
    if (!isObj(s) || typeof s.id !== 'string') throw new SignalConfigError('signals config: sentinel needs an id');
    const parts = strArray(s.parts, `sentinels.${s.id}.parts`);
    if (parts.length < 2) throw new SignalConfigError(`signals config: sentinel ${s.id} must be stored split (>= 2 parts)`);
    sentinels.set(parts.join(''), s.id);
  }

  if (j.provider_formats !== undefined) {
    // Removed in M1 integration: provider formats live only in config/prefixes.json. Refuse a stale second source.
    throw new SignalConfigError('signals config: provider_formats is not supported; use config/prefixes.json');
  }
  let providerFormats: PrefixSpec[];
  try {
    providerFormats = loadPrefixConfig(prefixesJson);
  } catch (e) {
    throw new SignalConfigError(`signals config: ${e instanceof Error ? e.message : 'invalid prefixes config'}`);
  }
  if (providerFormats.length === 0) throw new SignalConfigError('signals config: prefixes config lists no provider formats');

  if (!isObj(j.pem)) throw new SignalConfigError('signals config: pem must be an object');
  const minBody = j.pem.min_body_chars;
  if (typeof minBody !== 'number' || !Number.isInteger(minBody) || minBody < 1) {
    throw new SignalConfigError('signals config: pem.min_body_chars must be a positive integer');
  }

  const cfg: SignalConfig = {
    version: j.version,
    defs: Object.freeze(defs),
    entropyThresholds: Object.freeze(thr),
    entropyLengthFactor: factor,
    credentialKeywords: Object.freeze(strArray(j.credential_keywords, 'credential_keywords').map((k) => k.toLowerCase())),
    placeholderWords: Object.freeze(strArray(j.placeholder_words, 'placeholder_words').map((w) => w.toLowerCase())),
    placeholderPatterns: Object.freeze(strArray(j.placeholder_patterns, 'placeholder_patterns')
      .map((p, i) => compile(p, `placeholder_patterns[${i}]`, 'i'))),
    identifierWords: new Set(strArray(j.identifier_words, 'identifier_words').map((w) => w.toLowerCase())),
    sentinels,
    providerFormats: Object.freeze(providerFormats.map((f) => Object.freeze({ ...f }))),
    pem: Object.freeze({
      minBodyChars: minBody,
      elisionMarkers: Object.freeze(strArray(j.pem.elision_markers, 'pem.elision_markers').map((m) => m.toLowerCase())),
    }),
    lockfileBasenames: Object.freeze(strArray(j.lockfile_basenames, 'lockfile_basenames').map((b) => b.toLowerCase())),
    highPrecisionRules: Object.freeze(loadHighPrecisionRules(highPrecisionJson)),
  };
  return Object.freeze(cfg);
}

/**
 * Evaluate all 16 signals on one raw candidate. Returns signals in canonical order, each at most once.
 * `features` must come from computeFeatures (code-computed entropy); raw.scannerEntropy is deliberately ignored.
 */
export function evaluateSignals(raw: RawCandidate, features: Features, cfg: SignalConfig): Signal[] {
  const ctx = { raw, features, cfg, span: buildSpanContext(raw) };
  const hits: SignalHit[] = [
    ...evalRealSignals(ctx),
    ...evalSentinelSignals(ctx),
    ...evalReferenceSignals(ctx),
    ...evalShapeSignals(ctx),
    ...evalPathSignals(ctx),
  ];
  const seen = new Set<SignalId>();
  const out: Signal[] = [];
  for (const id of SIGNAL_ORDER) {
    const hit = hits.find((h) => h.id === id);
    if (!hit || seen.has(id)) continue;
    seen.add(id);
    const def = cfg.defs[id];
    // No FP predicate may treat a bounded prefix of the occurrences as exhaustive evidence.
    if (!ctx.span.complete && def.direction === 'fp') continue;
    const sig: Signal = { id, name: def.name, direction: def.direction, strength: def.strength, evidence: hit.pointer };
    if (def.downgradeOnly) sig.downgradeOnly = true;
    out.push(sig);
  }
  return out;
}

// Small predicates shared with policy/.
export function isStrongReal(s: Signal): boolean {
  return s.direction === 'real' && s.strength === 'strong';
}
export function isDecisiveReal(s: Signal): boolean {
  return s.direction === 'real' && s.strength === 'decisive';
}
export function isDecisiveFp(s: Signal): boolean {
  return s.direction === 'fp' && s.strength === 'decisive';
}
export function isWeakFp(s: Signal): boolean {
  return s.direction === 'fp' && s.strength === 'weak';
}

export { locateSpans, scanSpans, buildSpanContext, pemStatus, entropyThreshold } from './shapes.ts';
export type { Span, SpanContext, SignalContext, SignalHit, PemStatus } from './shapes.ts';
