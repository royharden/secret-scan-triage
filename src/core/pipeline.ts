// Import pipeline (docs/core-api.md "synth/ + pipeline"): raw report text -> masked Finding[] + session leak guard.
// Runs ONLY inside the parse worker (M2) or the Node eval process (M4): it holds raw values while it runs and returns
// masked data only. Raw references are dropped before returning. Pure TS: no DOM, no Node APIs (Web Crypto and
// TextEncoder are web-standard globals available in browser, worker and Node 24).
import type { Finding, Flags, MaskedLine, RawCandidate, VerifiedLabel } from './finding.ts';
import type { LeakGuard, SafeText } from './safe.ts';
import { LeakGuardError } from './safe.ts';
import { parseReport } from './ingest/index.ts';
import type { ReportFormat } from './ingest/index.ts';
import { computeFeatures } from './features/index.ts';
import { buildReportMatcher } from './mask/reportMatcher.ts';
import type { ReportMatcher } from './mask/reportMatcher.ts';
import { loadPrefixConfig, maskValue, prefixStrings } from './mask/mask.ts';
import { buildLeakGuard, createSessionSalt } from './mask/leakIndex.ts';
import { DEFAULT_RADIUS, MAX_RADIUS, buildWindow, isContextFileTooLarge, splitFileLines } from './context/window.ts';
import { matchPathSuffix, normalizeReportPath } from './context/pathMatch.ts';
import { buildSpanContext, evaluateSignals, loadSignalConfig } from './signals/index.ts';
import type { SignalConfig } from './signals/index.ts';
import { screenInjection } from './screen/prefilter.ts';
import { findingId, sanitizeFingerprint, valueTag } from './identity.ts';
import prefixesJson from '../../config/prefixes.json' with { type: 'json' };
import signalsJson from '../../config/signals.json' with { type: 'json' };
import highPrecisionJson from '../../config/high-precision-rules.json' with { type: 'json' };

export interface PipelineInput {
  text: string;
  format: ReportFormat;
  /** Persisted, client-only identity salt (>= 16 bytes). Never the guard salt. */
  projectSalt: Uint8Array;
  /** Optional folder context: selected file path -> text. Report paths are lookup keys into this map only. */
  files?: Record<string, string>;
  /** Context radius, clamped to <= 3 (7 lines total). */
  radius?: number;
  /** Import checkbox "verification was enabled for this scan": display label only, never policy. */
  verificationEnabled?: boolean;
}

export interface PipelineStats {
  candidates: number;
  withFileContext: number;
  contextMismatch: number;
  unmaskableContext: number;
  ambiguousPath: number;
  skippedLargeFiles: number;
  droppedFingerprints: number;
  maskedPaths: number;
  droppedCommits: number;
  injectionFlags: number;
  /**
   * Distinct self-produced digests (HMAC ids, valueTags) blocked by the strict guard. No digest exemption exists;
   * affected findings are flagged for review and artefacts carrying the blocked digest must be omitted.
   */
  refusedDigests: number;
}

export interface PipelineOutput {
  findings: Finding[];
  guard: LeakGuard;
  missingFields: Record<string, number>;
  stats: PipelineStats;
}

interface LoadedConfig {
  prefixes: string[];
  signals: SignalConfig;
}

let loaded: LoadedConfig | undefined;

/** Validated config (cached). Throws on invalid config: a broken config must never silently weaken masking. */
export function pipelineConfig(): LoadedConfig {
  if (loaded === undefined) {
    loaded = {
      // config/prefixes.json is the single source for both kept mask prefixes and S-R3 provider formats.
      prefixes: prefixStrings(loadPrefixConfig(prefixesJson)),
      signals: loadSignalConfig(signalsJson, highPrecisionJson, prefixesJson),
    };
  }
  return loaded;
}

/** Multi-line pieces long enough to index on their own (PEM body lines), in addition to the whole value. */
const MIN_PIECE_CHARS = 8;

function valuePieces(v: string): string[] {
  if (!v.includes('\n') && !v.includes('\r')) return [];
  return v.split(/\r\n|\r|\n/).map((s) => s.trim()).filter((s) => s.length >= MIN_PIECE_CHARS);
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

interface ContextLookup {
  lines: string[] | null;
  ambiguous: boolean;
  tooLarge: boolean;
}

function makeContextLookup(files: Record<string, string> | undefined): (reportPath: string) => ContextLookup {
  const none: ContextLookup = { lines: null, ambiguous: false, tooLarge: false };
  if (files === undefined) return () => none;
  const paths = Object.keys(files);
  const cache = new Map<string, ContextLookup>();
  return (reportPath: string): ContextLookup => {
    const hit = cache.get(reportPath);
    if (hit !== undefined) return hit;
    let out: ContextLookup = none;
    if (normalizeReportPath(reportPath) !== null) {
      const m = matchPathSuffix(reportPath, paths);
      if (m === 'ambiguous') out = { lines: null, ambiguous: true, tooLarge: false };
      else if (m !== null) {
        const text = files[m] as string;
        out = isContextFileTooLarge(utf8Length(text))
          ? { lines: null, ambiguous: false, tooLarge: true }
          : { lines: splitFileLines(text), ambiguous: false, tooLarge: false };
      }
    }
    cache.set(reportPath, out);
    return out;
  };
}

function clampRadius(r: number | undefined): number {
  if (r === undefined || !Number.isFinite(r)) return DEFAULT_RADIUS;
  return Math.max(0, Math.min(MAX_RADIUS, Math.floor(r)));
}

/** Raw lines that buildWindow may show for this candidate (used to prime the matcher and to screen injection). */
function rawWindowLines(c: RawCandidate, fileLines: string[] | null, radius: number): string[] {
  const out: string[] = [];
  if (fileLines !== null) {
    const idx = c.line - 1;
    const start = Math.max(0, idx - radius);
    const end = Math.min(fileLines.length - 1, idx + radius);
    for (let i = start; i <= end; i++) out.push(fileLines[i] as string);
  }
  if (typeof c.rawLine === 'string' && c.rawLine.length > 0) out.push(c.rawLine);
  return out;
}

/** Guard-check a metadata string; on a hit replace it with its masked form (or a fixed marker). */
function safeMeta(s: string, guard: LeakGuard, matcher: ReportMatcher, withheld: string): { text: string; changed: boolean } {
  try {
    guard.check(s, 'ui_state');
    return { text: s, changed: false };
  } catch (e) {
    if (!(e instanceof LeakGuardError)) throw e;
  }
  const m = matcher.maskLine(s);
  if ('text' in m) {
    try {
      guard.check(m.text, 'ui_state');
      return { text: m.text, changed: true };
    } catch (e) {
      if (!(e instanceof LeakGuardError)) throw e;
    }
  }
  return { text: withheld, changed: true };
}

interface Pending {
  raw: RawCandidate;
  features: Finding['features'];
  signals: Finding['signals'];
  flags: Flags;
  maskedValue: SafeText;
  window: MaskedLine[];
}

/**
 * parseReport -> computeFeatures -> report-wide matcher over all values -> evaluateSignals + screenInjection on raw ->
 * masked window -> maskValue -> identity (findingId, valueTag) -> session leak guard -> Finding[] (masked data only).
 * Throws ImportError (from ingest) for unsupported/malformed/oversized input; never echoes report text.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const cfg = pipelineConfig();
  const radius = clampRadius(input.radius);
  const parsed = parseReport(input.text, input.format);
  const candidates = parsed.candidates;
  const stats: PipelineStats = {
    candidates: candidates.length, withFileContext: 0, contextMismatch: 0, unmaskableContext: 0, ambiguousPath: 0,
    skippedLargeFiles: 0, droppedFingerprints: 0, maskedPaths: 0, droppedCommits: 0, injectionFlags: 0,
    refusedDigests: 0,
  };

  // 1. Report-wide matcher over every finding value (+ RawV2 extras + multi-line pieces).
  const values: string[] = [];
  for (const c of candidates) {
    values.push(c.rawValue, ...valuePieces(c.rawValue));
  }
  for (const v of parsed.extraValues) values.push(v, ...valuePieces(v));
  const matcher = buildReportMatcher(values, cfg.prefixes);

  // 2. Resolve context and prime the matcher with every raw line that may be shown, so unreported tokens anywhere in
  //    any window are learned before the first line is masked (masking is then independent of finding order).
  const lookup = makeContextLookup(input.files);
  const contexts = candidates.map((c) => lookup(c.path));
  const rawWindows = candidates.map((c, i) => rawWindowLines(c, (contexts[i] as ContextLookup).lines, radius));
  for (const w of rawWindows) matcher.prime(w);

  // 3. Per candidate, on raw: features, signals, injection screen; then masked window and masked value.
  const pending: Pending[] = [];
  candidates.forEach((c, i) => {
    const ctx = contexts[i] as ContextLookup;
    if (ctx.ambiguous) stats.ambiguousPath++;
    if (ctx.tooLarge) stats.skippedLargeFiles++;
    const features = computeFeatures(c);
    const signals = evaluateSignals(c, features, cfg.signals);
    const win = buildWindow(ctx.lines, c, matcher, radius);
    // Screen exactly the raw text the window was built from (file lines, or the match line on fallback/mismatch).
    const screened = ctx.lines !== null && !win.mismatch
      ? rawWindowLines(c, ctx.lines, radius)
      : (typeof c.rawLine === 'string' ? [c.rawLine] : []);
    const injection = screenInjection(screened);
    if (ctx.lines !== null && !win.mismatch) stats.withFileContext++;
    if (win.mismatch) stats.contextMismatch++;
    if (win.unmaskable) stats.unmaskableContext++;
    if (injection) stats.injectionFlags++;
    const m = maskValue(c.rawValue, cfg.prefixes);
    // m.keptPrefix is not carried: the kept prefix is visible in maskedValue and is not a Finding field.
    const p: Pending = {
      raw: c,
      features,
      signals,
      flags: {
        injection,
        // A finding that cannot be located (no path or line) cannot have span-bound evidence: review.
        malformedEvidence: c.path.length === 0 || !(c.line >= 1) || !buildSpanContext(c).complete,
        contextMismatch: win.mismatch,
        unmaskableContext: win.unmaskable,
      },
      maskedValue: m.masked,
      window: win.lines,
    };
    pending.push(p);
  });

  // 4. Session leak guard: all known values plus every unreported token learned while masking. Fresh session salt.
  const guard = buildLeakGuard(matcher.knownValues(), matcher.keptPrefixes(), createSessionSalt());

  // 5. Identity and metadata sanitising; build masked findings.
  const findings: Finding[] = [];
  const digestChecks = new Map<string, boolean>();
  const digestBlocked = (digest: string): boolean => {
    const cached = digestChecks.get(digest);
    if (cached !== undefined) return cached;
    let blocked = false;
    try {
      guard.check(digest, 'ui_state');
    } catch (e) {
      if (!(e instanceof LeakGuardError)) throw e;
      blocked = true;
      stats.refusedDigests++;
    }
    digestChecks.set(digest, blocked);
    return blocked;
  };
  for (const p of pending) {
    const c = p.raw;
    const fp = sanitizeFingerprint(c.fingerprint, guard);
    if (c.fingerprint !== undefined && fp === undefined) stats.droppedFingerprints++;
    const id = await findingId(c, input.projectSalt, fp);
    const tag = await valueTag(c.rawValue, input.projectSalt);
    // Digests are never exempt. Accidental six-gram overlap still blocks output; mark the finding for review.
    const idBlocked = fp === undefined && digestBlocked(id);
    const tagBlocked = digestBlocked(tag);
    const path = safeMeta(c.path, guard, matcher, '[path withheld]');
    if (path.changed) stats.maskedPaths++;
    const ruleId = safeMeta(c.ruleId, guard, matcher, 'unknown-rule').text;
    let commit: string | undefined;
    if (c.commit !== undefined) {
      const cm = safeMeta(c.commit, guard, matcher, '');
      if (cm.changed) stats.droppedCommits++;
      else commit = cm.text;
    }
    const verified = c.verifiedRaw === true ? 'verified' : 'unknown';
    const verifiedLabel: VerifiedLabel = verified === 'verified'
      ? 'verified'
      : c.scanner === 'trufflehog' && input.verificationEnabled === true ? 'unverified' : 'unknown';
    const f: Finding = {
      id,
      scanner: c.scanner,
      origin: c.scanner,
      ruleId,
      path: path.text,
      line: c.line,
      maskedValue: p.maskedValue,
      length: p.features.length,
      charClass: p.features.charClass,
      verified,
      verifiedLabel,
      valueTag: tag,
      features: p.features,
      signals: p.signals,
      flags: { ...p.flags, malformedEvidence: p.flags.malformedEvidence || idBlocked || tagBlocked },
      maskedWindow: p.window,
    };
    if (commit !== undefined) f.commit = commit;
    if (fp !== undefined) f.fingerprint = fp;
    if (c.scannerEntropy !== undefined) f.scannerEntropy = c.scannerEntropy;
    findings.push(f);
  }

  // 6. Drop raw references held by this call (GC cannot promise zeroisation; this only releases references).
  candidates.length = 0;
  parsed.extraValues.length = 0;
  values.length = 0;
  rawWindows.length = 0;
  pending.length = 0;

  return { findings, guard, missingFields: parsed.missingFields, stats };
}
