# Core API seams (M1 provisional contract)

## M5 cloud identity and live accounting boundary

Before binding/replay in a cloud import, `mapCloudFindingIds` replaces each operational `Finding.id` with full HMAC-SHA256 using
the existing client-only persisted project salt and JSON encoding of
`["secret-scan-triage/cloud-finding-id/v1", ownerId, projectKey, originalOperationalId]`. This is cloud-session mapping only:
offline/pipeline ids are unchanged, and the original `Finding.fingerprint` remains local for approved `.gitleaksignore` download.
Binding, replay and cloud ruling drafts all use the same stable opaque cloud id. The salt and original-id mapping are never
uploaded. Derived ids and resulting items are guard-checked; failure omits the item and increments blocked count, never falls back
to a path-bearing id. A matching salt/scope/id replays the same opaque identity; content/value binding checks remain mandatory.

`ChargedProviderError.usageUnknown` carries code-owned uncertainty when reserve/claim cannot establish a fresh dispatch, including
same-key already-dispatching/settled work. There is no second fetch. Numeric zero placeholders with `usage_unknown: true` are not
a zero-charge assertion or an additional copy of a prior charge. Judge retry and semantic-screen aggregation preserve that flag;
durable usage rows remain authoritative. Existing conservative charged-attempt estimates retain `usage_estimated` separately.

Browser `Session.liveAccounting` is per-import state independent of visible rows and whole-budget totals. Begin latches pending
live work before awaiting; trusted returned actual cost accumulates across actions, estimates stay separate, and unknown/estimated/
partial/caught/incomplete actions remain sticky-uncertain. Only fully completed, entirely known actual accounting can populate
`triage_runs.cost_usd`; otherwise it is null. A possible live action keeps live source provenance even if every result is withheld
or null. New imports reset the state. Later success cannot certify an earlier ambiguous action, and consent/guard/cohort failures
after a possible dispatch leave uncertainty rather than a measured zero. Full server budget/day accounting remains authoritative.

Integrator-owned. Producers and consumers build against these signatures concurrently; reconcile against as-built code at the end of
each milestone. Types live in `src/core/finding.ts` and `src/core/safe.ts`. All relative imports use the `.ts` extension. `.ts` files
use erasable-only TypeScript (no `enum`, `namespace`, parameter properties, decorators).

## safe.ts (owner: package A)
```ts
export type SafeText = string & { readonly __safe: unique symbol };
export type Boundary = 'judge_request' | 'function_request' | 'ledger' | 'log' | 'import_error' | 'export' | 'rulings_idb'
  | 'rulings_cloud' | 'cache' | 'model_text' | 'ui_state' | 'note';
/** Only mask/*.ts may call this (eslint no-restricted-syntax; exempt: src/core/mask/**, safe.ts, tests/**). */
export function unsafeMarkSafe(s: string): SafeText;
export class LeakGuardError extends Error { boundary: Boundary; findingId?: string }   // message/toString always empty; fields INTERNAL
export interface LeakGuard {
  readonly ready: boolean;
  check(text: string, boundary: Boundary, findingId?: string): void;   // throws LeakGuardError
  /** Compatibility no-op: always returns 0. No digest is exempt from the strict scan. */
  exemptDigests(hexes: readonly string[]): number;
}
/** JSON.stringify(value) then guard.check; throws LeakGuardError. The ONLY outbound path. */
export function serializeSafe(value: unknown, boundary: Boundary, guard: LeakGuard, findingId?: string): string;
/** Guard used after reload before re-import: ready=false, check() always throws, exemptDigests() accepts nothing (0). */
export const NOT_READY_GUARD: LeakGuard;
```

### Strict privacy interpretation (M1 review repair)
The strict P4/M1 known-value rule takes precedence over the historical digest relaxation: the only permitted exception is a
listed provider prefix at its kept position. A genuine HMAC and a caller-assembled 64-hex string are both blocked if they carry
a known six-gram. `guard.exemptDigests(hexes)` remains a compatibility no-op returning zero; it registers nothing. The independent
test oracle has no digest exemption. Every nonempty value shorter than six characters, including lengths one and two, is indexed
whole and checked at token boundaries. Unusable output is omitted; the guarantee is never relaxed for availability.

`runPipeline` checks generated HMAC fallback ids and valueTags against the strict guard. `stats.refusedDigests` counts distinct
blocked digests, and affected findings receive `flags.malformedEvidence` so policy routes them to review (scanner-verified real
still takes its specified keep precedence). Their artefacts remain blocked by `serializeSafe`; callers must omit unsafe material
and omit unguarded error details. `LeakGuardError.message` and `String(error)` are always empty: fixed boilerplate such as the
boundary name can itself equal a known value. `name`, `boundary`, `reason`, `stack` and any separately vetted `findingId` are
internal diagnostics, not display text. To show or emit diagnostic details, construct a payload and pass it through `serializeSafe`
with a ready guard; on failure or an unavailable guard, omit those details. The legacy `showIdInMessage` option controls only
retention of a separately vetted structured id, never public text. Collision frequency and performance remain unmeasured in D10.

Span enumeration retains at most 64 occurrences and exposes `SpanContext.complete`. When incomplete, all FP signals are suppressed
and the pipeline sets `malformedEvidence`, preventing judge dismissal as well. PEM evidence requires a complete, unnested block
with matching BEGIN/END labels: real evidence needs a bound full body; decisive elided evidence must cover every occurrence of
the finding. An unrelated literal after END cannot inherit either signal. Incomplete/ambiguous blocks provide no PEM evidence.

## mask/ (owner: package A)
```ts
// mask/leakIndex.ts — synchronous keyed 64-bit hash (session salt, never persisted). Fail closed on collisions.
export interface KeptPrefix { value: string; prefix: string }
export function createSessionSalt(): Uint8Array;                      // crypto.getRandomValues
export function buildLeakGuard(values: string[], keptPrefixes: KeptPrefix[], sessionSalt: Uint8Array): LeakGuard;
// mask/leakGuard.ts — shared scan + the guarded SafeText constructor for modules outside mask/
export function guardedSafeText(text: string, boundary: Boundary, guard: LeakGuard, findingId?: string): SafeText; // throws LeakGuardError
// mask/mask.ts — config/prefixes.json is the ONE source of provider formats (kept mask prefixes AND S-R3)
export interface PrefixSpec { prefix: string; provider?: string; length?: number; minLength?: number; maxLength?: number; charset?: string }
export function loadPrefixConfig(json: unknown): PrefixSpec[];        // throws on invalid config
export function prefixStrings(specs: readonly PrefixSpec[]): string[];
export function maskValue(raw: string, prefixes: string[]): { masked: SafeText; keptPrefix?: string };  // keptPrefix is NOT copied to Finding
export function matchProviderFormat(value: string, specs: readonly PrefixSpec[]): PrefixSpec | undefined; // S-R3
/** Basename of an already guard-checked path (Finding.path); brands without a second check (serializeSafe re-checks outbound). */
export function safeBasename(path: SafeText | string): SafeText;      // used by judge/views.ts for MaskedView.basename
// mask/tokens.ts — generic credential-looking token detector (len>=16 & entropy above class threshold, or known-prefix regex)
export function findCredentialTokens(text: string): Array<{ start: number; end: number; value: string }>;
// mask/reportMatcher.ts — masks every known finding value + detected tokens in a line
export interface ReportMatcher { maskLine(rawLine: string): { text: SafeText } | { unmaskable: true }; knownValues(): string[] }
export function buildReportMatcher(values: string[], prefixes: string[]): ReportMatcher;
```

## ingest/ (owner: package A)
```ts
export type ReportFormat = 'gitleaks' | 'trufflehog';
export const MAX_BYTES = 20_000_000; export const MAX_FINDINGS = 20_000;
export function checkSize(byteLength: number): void;                  // throws ImportError
export function detectFormat(text: string): ReportFormat | 'ambiguous' | 'unsupported';
export function parseReport(text: string, format: ReportFormat): { candidates: RawCandidate[]; missingFields: Record<string, number> };
export class ImportError extends Error { code: 'too_large' | 'too_many' | 'unsupported' | 'ambiguous' | 'malformed'; location?: string; count?: number }
```

## features/ & context/ (owner: package A)
```ts
export function computeFeatures(raw: RawCandidate): Features;         // entropy computed here, never from scanner entropy
export function shannonEntropy(s: string): number; export function classifyChars(s: string): CharClass; export function classifyPath(p: string): PathClass;
// context/: pure helpers; folder wiring in M3
export function normalizeReportPath(p: string): string | null;        // null = unsafe/traversal
export function matchPathSuffix(reportPath: string, filePaths: string[]): string | 'ambiguous' | null;
export function buildWindow(fileLines: string[] | null, raw: RawCandidate, matcher: ReportMatcher, radius?: number /*<=3*/): { lines: MaskedLine[]; mismatch: boolean; unmaskable: boolean };
```

## signals/, policy/, judge/, providers/, screen/ (owner: package B)
```ts
export function evaluateSignals(raw: RawCandidate, features: Features, cfg: SignalConfig): Signal[];   // runs in worker on raw
// S-R3 formats come from config/prefixes.json (cfg.providerFormats: PrefixSpec[]); signals.json has no provider_formats.
export function loadSignalConfig(signalsJson: unknown, highPrecisionJson: unknown, prefixesJson: unknown): SignalConfig; // throws SignalConfigError
export function screenInjection(rawLineAndWindow: string[]): boolean;                                   // screen/prefilter.ts
export interface Thresholds { source: 'untuned-default' | 'dev-tuned'; judge_dismiss_enabled: boolean; t_dismiss: number; t_keep: number; target_recall: number; infeasible?: boolean }
export function loadThresholds(json: unknown): Thresholds;             // throws on invalid
export function resolveDeterministic(signals: Signal[], flags: Flags): Stage1Outcome;
export function decideWithJudge(f: Finding, j: JudgeResult, t: Thresholds, highPrecisionRules: string[]): Band;
export function decide(f: Finding, j: JudgeResult | null, t: Thresholds, hp: string[]): { band: Band; stage: 1 | 2; reasons: string[] };
// judge/
export type ReasonCode = 'placeholder' | 'reference_not_literal' | 'test_value' | 'hash_or_id' | 'docs_example' | 'looks_real' | 'cannot_tell';
export interface MaskedView { findingId; ruleId; pathClass; basename: SafeText; maskedLine: SafeText; maskedWindow: MaskedLine[]; lengthBucket; entropyBucket; charClass; signalBuckets: string[]; scannerVerified: boolean }
export interface JudgeResult { p_real: number; reason_code: ReasonCode; cited_lines?: string[]; usage: { calls: number; inputTokens: number; outputTokens: number; usd: number }; status: 'ok' | 'not_requested' | 'failed'; model_text?: SafeText; provider: string; modelId: string }
export interface Judge { id: string; judge(view: MaskedView): Promise<JudgeResult> }
export function buildMaskedView(f: Finding): MaskedView | null;   // null if > 4 KiB after shrinking -> review
export function buildLlmOnlyView(f: Finding): MaskedView | null;  // ±1 line, no signalBuckets
export function validateJudgeOutput(raw: unknown, view: MaskedView, opts: { citationsRequired: boolean }, guard: LeakGuard): JudgeResult | { invalid: string };
// model_text is branded via guardedSafeText (mask/leakGuard.ts); MaskedView.basename via safeBasename (mask/mask.ts).
// validate.ts now imports mask/leakGuard.ts, so the C12 edge-function sync list must include src/core/mask/leakGuard.ts
// (it imports only safe.ts, so the list stays closed under imports).
export function judgeWithRetry(judge: Judge-like raw caller, view, guard): Promise<JudgeResult>;  // one retry then status 'failed'
// providers/mock.ts
export function createMockJudge(seed: number): Judge;              // id 'mock-scripted-v1'
```

## synth/ + pipeline (owner: package C)
```ts
export interface SynthOptions { seed: number; size?: number /* ~400 */; variant?: 'run1' | 'run2' }
export interface SynthResult { gitleaksJson: string; trufflehogNdjson: string; files: Record<string, string>; labels: Record<string /*finding key*/, { real: boolean; trap?: string; group: string }>; manifest: SynthManifest }
export function generateSynthetic(opts: SynthOptions): SynthResult;
// pipeline.ts — used by the worker (M2) and Node eval (M4)
export function runPipeline(input: { text: string; format: ReportFormat; projectSalt: Uint8Array; files?: Record<string, string> }): Promise<{ findings: Finding[]; guard: LeakGuard; missingFields: Record<string, number> }>;
// The returned guard exempts no digests. stats.refusedDigests counts blocked HMAC ids/valueTags; affected findings are flagged.
```
