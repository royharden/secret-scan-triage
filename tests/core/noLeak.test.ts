// No-leak suite (Claude §5.1, PLAN M1 item 9). Written in Dirty Mode construction, NOT run (D3, D20).
// Runs the whole synthetic set through runPipeline + scripted mock judge + decide, serialises every outbound artefact that
// exists in M1 through serializeSafe (finding UI state, judge views, LLM-only views, judge results, JSON export payload,
// import summary, import errors, guard errors) and asserts that no raw value and no 6-character substring of one appears,
// except a kept provider prefix at its kept position (followed by the mask character); values shorter than 6 characters
// are checked as whole values at token boundaries (including lengths one and two). No digest exception exists.
// A LeakGuardError means the artefact was omitted (fail closed). Its public message is empty; diagnostic fields are internal.
// what_bug_this_catches: a value (or a neighbour's value, an unreported token, a repeated value, a short value) escaping
// via a window line, a path, a fingerprint, a commit, a judge view/result, an export or an error message.
import { describe, expect, it } from 'vitest';
import thresholdsJson from '../../config/thresholds.json' with { type: 'json' };
import highPrecisionJson from '../../config/high-precision-rules.json' with { type: 'json' };
import { generateSynthetic, labelKey } from '../../src/core/synth/index.ts';
import type { SynthResult } from '../../src/core/synth/index.ts';
import { buildToken } from '../../src/core/synth/tokens.ts';
import { createRng } from '../../src/core/rng.ts';
import { pipelineConfig, runPipeline } from '../../src/core/pipeline.ts';
import type { PipelineOutput } from '../../src/core/pipeline.ts';
import { createMockJudge } from '../../src/core/providers/mock.ts';
import { buildLlmOnlyView, buildMaskedView } from '../../src/core/judge/views.ts';
import { decide, loadThresholds } from '../../src/core/policy/decide.ts';
import { loadHighPrecisionRules } from '../../src/core/signals/index.ts';
import { LeakGuardError, NOT_READY_GUARD, serializeSafe } from '../../src/core/safe.ts';
import type { Boundary, LeakGuard } from '../../src/core/safe.ts';
import { ImportError, parseReport } from '../../src/core/ingest/index.ts';
import type { ReportFormat } from '../../src/core/ingest/index.ts';
import { buildLeakGuard, createSessionSalt } from '../../src/core/mask/leakIndex.ts';
import { maskValue } from '../../src/core/mask/mask.ts';
import { hmacHex } from '../../src/core/identity.ts';
import type { Finding } from '../../src/core/finding.ts';
import { walk } from './_helpers.ts';

const SEED = 4242;
const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);
const thresholds = loadThresholds(thresholdsJson);
const hp = loadHighPrecisionRules(highPrecisionJson);
const judge = createMockJudge(SEED);
const prefixes = pipelineConfig().prefixes;

// ---- independent leak checker (mirrors the stated rule, not the guard's implementation) ----

const GRAM = 6;
const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

interface Oracle {
  grams: Set<string>;
  shorts: Map<number, Set<string>>;
  keptPrefixes: string[];
}

function buildOracle(values: readonly string[]): Oracle {
  const grams = new Set<string>();
  const shorts = new Map<number, Set<string>>();
  const kept = new Set<string>();
  for (const v of values) {
    if (v.length === 0) continue;
    if (v.length < GRAM) {
      shorts.set(v.length, (shorts.get(v.length) ?? new Set()).add(v));
      continue;
    }
    for (let i = 0; i + GRAM <= v.length; i++) {
      const g = v.slice(i, i + GRAM);
      if (!/^\*+$/.test(g)) grams.add(g);
    }
    const kp = maskValue(v, prefixes).keptPrefix;
    if (kp !== undefined) kept.add(kp);
  }
  return { grams, shorts, keptPrefixes: [...kept] };
}

/** Spans where a kept prefix sits at its kept position: token boundary before, mask character after. */
function keptSpans(text: string, kept: readonly string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of kept) {
    for (let at = text.indexOf(p); at !== -1; at = text.indexOf(p, at + 1)) {
      if (!isWord(text[at - 1]) && text[at + p.length] === '*') out.push([at, at + p.length]);
    }
  }
  return out;
}

/** Number of leak hits in `text` (positions only; never returns raw material). */
function leakCount(text: string, o: Oracle): number {
  const spans = keptSpans(text, o.keptPrefixes);
  const exempt = (s: number, e: number) => spans.some(([a, b]) => a <= s && e <= b);
  let hits = 0;
  for (let i = 0; i + GRAM <= text.length; i++) {
    if (o.grams.has(text.slice(i, i + GRAM)) && !exempt(i, i + GRAM)) hits++;
  }
  for (const [len, set] of o.shorts) {
    for (let i = 0; i + len <= text.length; i++) {
      if (!isWord(text[i - 1]) && !isWord(text[i + len]) && set.has(text.slice(i, i + len)) && !exempt(i, i + len)) hits++;
    }
  }
  return hits;
}

/** Check serialised text AND every decoded string leaf (JSON escaping must not hide a value). */
function artefactLeaks(text: string, o: Oracle): number {
  let n = leakCount(text, o);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return n; // plain-text artefact (e.g. an error message)
  }
  for (const s of walk(parsed).strings) n += leakCount(s, o);
  return n;
}

// ---- artefact capture ----

interface Capture {
  texts: Array<{ label: string; text: string }>;
  omitted: number;
  emitted: number;
}

function newCapture(): Capture {
  return { texts: [], omitted: 0, emitted: 0 };
}

function emit(cap: Capture, label: string, value: unknown, boundary: Boundary, guard: LeakGuard, id?: string): boolean {
  try {
    cap.texts.push({ label, text: serializeSafe(value, boundary, guard, id) });
    cap.emitted++;
    return true;
  } catch (e) {
    if (!(e instanceof LeakGuardError)) throw e;
    cap.omitted++;
    cap.texts.push({ label: `${label}:guard-error`, text: e.message }); // empty public text; never display diagnostic fields
    return false;
  }
}

function keyOf(f: Finding): string {
  return labelKey(f.scanner, f.path, f.line, f.ruleId);
}

interface Scenario {
  name: string;
  synth: SynthResult;
  format: ReportFormat;
  withFiles: boolean;
}

const run1 = generateSynthetic({ seed: SEED });
const run2 = generateSynthetic({ seed: SEED, variant: 'run2' });

const scenarios: Scenario[] = [];
for (const [vname, synth] of [['run1', run1], ['run2', run2]] as const) {
  for (const format of ['gitleaks', 'trufflehog'] as const) {
    for (const withFiles of [false, true]) {
      scenarios.push({ name: `${vname}/${format}/${withFiles ? 'files' : 'match-line'}`, synth, format, withFiles });
    }
  }
}

async function runScenario(s: Scenario): Promise<{ out: PipelineOutput; cap: Capture; findingExports: number }> {
  const out = await runPipeline({
    text: s.format === 'gitleaks' ? s.synth.gitleaksJson : s.synth.trufflehogNdjson,
    format: s.format,
    projectSalt: SALT,
    ...(s.withFiles ? { files: s.synth.files } : {}),
  });
  const cap = newCapture();
  let findingExports = 0;
  for (const f of out.findings) {
    emit(cap, `ui:${f.id}`, f, 'ui_state', out.guard, f.id);
    if (emit(cap, `export1:${f.id}`, { findings: [f] }, 'export', out.guard, f.id)) findingExports++;
    const view = buildMaskedView(f);
    if (view !== null) {
      emit(cap, `view:${f.id}`, view, 'judge_request', out.guard, f.id);
      const result = await judge.judge(view);
      emit(cap, `result:${f.id}`, result, 'cache', out.guard, f.id);
      const d = decide(f, result, thresholds, hp);
      expect(['keep', 'review', 'dismiss']).toContain(d.band);
    }
    const llm = buildLlmOnlyView(f);
    if (llm !== null) emit(cap, `llm:${f.id}`, llm, 'judge_request', out.guard, f.id);
  }
  emit(cap, 'export:all', { findings: out.findings }, 'export', out.guard);
  emit(cap, 'summary', { missingFields: out.missingFields, stats: out.stats }, 'ui_state', out.guard);
  return { out, cap, findingExports };
}

describe('no-leak: whole synthetic set through the pipeline (M1 surfaces)', () => {
  for (const s of scenarios) {
    it(`${s.name}: no raw value or 6-gram in any outbound artefact`, async () => {
      const { out, cap, findingExports } = await runScenario(s);
      const o = buildOracle([...s.synth.rawOracle.reportedValues, ...s.synth.rawOracle.unreportedValues]);
      expect(out.findings.length).toBeGreaterThan(0);
      let leaks = 0;
      const leaking: string[] = [];
      for (const a of cap.texts) {
        const n = artefactLeaks(a.text, o);
        if (n > 0) {
          leaks += n;
          leaking.push(a.label);
        }
      }
      expect(leaking).toEqual([]);
      expect(leaks).toBe(0);
      // Non-vacuous: most findings must actually be exportable. A low rate means the guard over-blocks (D10).
      expect(findingExports / out.findings.length).toBeGreaterThanOrEqual(0.5);
      expect(cap.emitted).toBeGreaterThan(out.findings.length);
    });
  }
});

describe('no-leak fixtures', () => {
  // what_bug_this_catches: the error capture displayed the known six-gram "export" from fixed boundary boilerplate.
  it('captures no error text when a known value equals the boundary name', () => {
    const value = 'export';
    const guard = buildLeakGuard([value], [], createSessionSalt());
    const capture = newCapture();
    expect(emit(capture, 'boundary-collision', { note: value }, 'export', guard)).toBe(false);
    expect(capture.omitted).toBe(1);
    expect(capture.texts).toEqual([{ label: 'boundary-collision:guard-error', text: '' }]);
    expect(artefactLeaks(capture.texts[0]!.text, buildOracle([value]))).toBe(0);
  });

  // what_bug_this_catches: an oracle copied the digest exemption and skipped short values, concealing both leaks.
  it('the independent oracle rejects digest six-grams and every nonempty short value', async () => {
    const digest = await hmacHex(SALT, 'independent oracle collision fixture');
    const rawHex = '0'.repeat(10) + digest.slice(20, 26) + '1'.repeat(24);
    const oracle = buildOracle([rawHex]);
    expect(leakCount(digest, oracle)).toBeGreaterThan(0);
    const guard = buildLeakGuard([rawHex], [], createSessionSalt());
    expect(guard.exemptDigests([digest])).toBe(0);
    expect(() => serializeSafe({ id: digest }, 'export', guard)).toThrow(LeakGuardError);
    for (const short of ['Q', 'Q7', '"\\', '\u001f']) {
      const o = buildOracle([short]);
      expect(leakCount(short, o)).toBeGreaterThan(0);
      expect(artefactLeaks(JSON.stringify({ note: short }), o)).toBeGreaterThan(0);
      expect(leakCount(`x${short}x`, o)).toBe(0);
    }
  });

  it('one/two-character values are masked in pipeline contexts and paths; notes and escaped JSON fail closed', async () => {
    for (const short of ['Q', 'Q7', '"\\', '\u001f']) {
      const report = [{ RuleID: 'generic', Secret: short, Line: `pin='${short}';`, File: `keys/${short}/scan.txt`, StartLine: 1 }];
      const out = await runPipeline({ text: JSON.stringify(report), format: 'gitleaks', projectSalt: SALT });
      const f = out.findings[0] as Finding;
      const oracle = buildOracle([short]);
      expect(f.maskedValue).toBe('*'.repeat(short.length));
      expect(f.path).toBe(`keys/${'*'.repeat(short.length)}/scan.txt`);
      expect(f.maskedWindow.some((l) => l.lineId === 'L0')).toBe(true);
      for (const l of f.maskedWindow) expect(leakCount(l.text, oracle)).toBe(0);
      const capture = newCapture();
      expect(emit(capture, 'short-context', { path: f.path, window: f.maskedWindow }, 'export', out.guard)).toBe(true);
      for (const a of capture.texts) expect(artefactLeaks(a.text, oracle)).toBe(0);
      expect(() => serializeSafe({ note: short }, 'note', out.guard)).toThrow(LeakGuardError);
      expect(() => serializeSafe({ escaped: `prefix '${short}' suffix` }, 'export', out.guard)).toThrow(LeakGuardError);
    }
  });

  it('a genuine pipeline valueTag collision flags review and blocks the artefact', async () => {
    const value = 'synthetic-metadata-fixture';
    const tag = await hmacHex(SALT, `value|${value}`);
    const rawHex = '2'.repeat(10) + tag.slice(20, 26) + '3'.repeat(24);
    const report = [value, rawHex].map((Secret, i) => ({
      RuleID: 'generic', Secret, Line: `key = '${Secret}'`, File: `src/file${i}.ts`, StartLine: 1,
    }));
    const out = await runPipeline({ text: JSON.stringify(report), format: 'gitleaks', projectSalt: SALT });
    const f = out.findings[0] as Finding;
    expect(f.valueTag).toBe(tag);
    expect(f.flags.malformedEvidence).toBe(true);
    expect(out.stats.refusedDigests).toBeGreaterThanOrEqual(1);
    expect(decide(f, null, thresholds, hp).band).toBe('review');
    expect(() => serializeSafe(f, 'ui_state', out.guard, f.id)).toThrow(LeakGuardError);
    expect(leakCount(f.valueTag, buildOracle([rawHex]))).toBeGreaterThan(0);
  });

  it('unreported secrets in context windows are masked and guarded (files)', async () => {
    const out = await runPipeline({ text: run1.gitleaksJson, format: 'gitleaks', projectSalt: SALT, files: run1.files });
    const hidden = run1.rawOracle.unreportedValues;
    expect(hidden.length).toBeGreaterThan(0);
    const o = buildOracle(hidden);
    for (const f of out.findings) for (const l of f.maskedWindow) expect(leakCount(l.text, o)).toBe(0);
    for (const h of hidden) expect(() => out.guard.check(`note: ${h}`, 'note')).toThrow(LeakGuardError);
  });

  it('T15 repeated values and adjacent pairs are all present and masked (files)', async () => {
    const out = await runPipeline({ text: run1.gitleaksJson, format: 'gitleaks', projectSalt: SALT, files: run1.files });
    const byKey = new Map(out.findings.map((f) => [keyOf(f), f]));
    const o = buildOracle(run1.rawOracle.reportedValues);
    const keys = [...run1.rawOracle.repeatedValueKeys, ...run1.rawOracle.adjacentPairKeys].filter((k) => k.startsWith('gitleaks|'));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const f = byKey.get(k);
      expect(f).toBeDefined();
      for (const l of (f as Finding).maskedWindow) expect(leakCount(l.text, o)).toBe(0);
      expect(leakCount((f as Finding).maskedValue, o)).toBe(0);
    }
    // Adjacent pairs: with folder context each pair member's window holds the other's (masked) line.
    const adj = run1.rawOracle.adjacentPairKeys.filter((k) => k.startsWith('gitleaks|'));
    expect(adj.some((k) => ((byKey.get(k) as Finding).maskedWindow.length) >= 2)).toBe(true);
  });

  it('a value inside git-mode fingerprints drops those fingerprints and commits (falls back to HMAC id)', async () => {
    const out = await runPipeline({ text: run1.gitleaksJson, format: 'gitleaks', projectSalt: SALT });
    const values = run1.rawOracle.fingerprintValues;
    expect(values.length).toBeGreaterThan(0);
    const o = buildOracle(values);
    const gitGroup = run1.manifest.groups.find((g) => g.gitMode)?.id as string;
    const inGroup = out.findings.filter((f) => f.path.startsWith(`${gitGroup}/`));
    expect(inGroup.length).toBeGreaterThan(0);
    for (const f of inGroup) {
      expect(f.fingerprint).toBeUndefined();
      expect(f.commit).toBeUndefined();
      expect(f.id).toMatch(/^[0-9a-f]{64}$/);
      // A chance HMAC collision is permitted to make an artefact unavailable, never to weaken the oracle.
      if (leakCount(f.id, o) > 0) {
        expect(f.flags.malformedEvidence).toBe(true);
        expect(() => serializeSafe(f, 'export', out.guard)).toThrow(LeakGuardError);
      }
    }
    expect(out.stats.droppedFingerprints).toBeGreaterThanOrEqual(inGroup.length);
  });

  it('a value inside the report path is masked out of Finding.path, the fingerprint and the export', async () => {
    const tok = buildToken('github_pat', createRng(11));
    const file = ['keys', '/', tok, '.txt'].join('');
    const rec = {
      RuleID: 'github-pat', Description: 'x', StartLine: 1, EndLine: 1, StartColumn: 1, EndColumn: tok.length, Match: tok,
      Secret: tok, File: file, SymlinkFile: '', Commit: '', Entropy: 4.5, Author: '', Email: '', Date: '', Message: '', Tags: [],
      Fingerprint: `${file}:github-pat:1`,
    };
    const out = await runPipeline({ text: JSON.stringify([rec]), format: 'gitleaks', projectSalt: SALT });
    const f = out.findings[0] as Finding;
    const o = buildOracle([tok]);
    expect(f.fingerprint).toBeUndefined();
    expect(leakCount(f.path, o)).toBe(0);
    expect(out.stats.maskedPaths).toBe(1);
    const text = serializeSafe({ findings: [f] }, 'export', out.guard);
    expect(artefactLeaks(text, o)).toBe(0);
  });

  it('a note-like field holding a value (whole, partial or short) is refused; a clean note passes', async () => {
    const out = await runPipeline({ text: run1.gitleaksJson, format: 'gitleaks', projectSalt: SALT });
    const long = run1.rawOracle.reportedValues.find((v) => v.length >= 20) as string;
    const short = run1.rawOracle.shortValues[0] as string;
    expect(long).toBeDefined();
    expect(short).toBeDefined();
    expect(() => serializeSafe({ note: `rotated ${long} yesterday` }, 'note', out.guard)).toThrow(LeakGuardError);
    expect(() => serializeSafe({ note: `partial ${long.slice(7, 13)} only` }, 'note', out.guard)).toThrow(LeakGuardError);
    expect(() => serializeSafe({ note: `pin is ${short} ok` }, 'note', out.guard)).toThrow(LeakGuardError);
    expect(() => serializeSafe({ note: 'rotated by ops on Monday' }, 'note', out.guard)).not.toThrow();
  });

  it('run-2 T19: same id, fingerprint and mask; different valueTag. Changed context: same id and tag, new window', async () => {
    const a = await runPipeline({ text: run1.gitleaksJson, format: 'gitleaks', projectSalt: SALT, files: run1.files });
    const b = await runPipeline({ text: run2.gitleaksJson, format: 'gitleaks', projectSalt: SALT, files: run2.files });
    const find = (out: PipelineOutput, k: string) => out.findings.find((f) => keyOf(f) === k) as Finding;
    const r1 = find(a, run1.manifest.run2.replacedKey);
    const r2 = find(b, run1.manifest.run2.replacedKey);
    expect(r1 && r2).toBeTruthy();
    expect(r2.id).toBe(r1.id);
    expect(r2.fingerprint).toBe(r1.fingerprint);
    expect(r2.maskedValue).toBe(r1.maskedValue);
    expect(r2.valueTag).not.toBe(r1.valueTag);
    const c1 = find(a, run1.manifest.run2.contextChangedKey);
    const c2 = find(b, run1.manifest.run2.contextChangedKey);
    expect(c2.id).toBe(c1.id);
    expect(c2.valueTag).toBe(c1.valueTag);
    expect(c2.maskedValue).toBe(c1.maskedValue);
    expect(JSON.stringify(c2.maskedWindow)).not.toBe(JSON.stringify(c1.maskedWindow));
  });

  it('import errors never echo report text', () => {
    const tok = buildToken('stripe_live', createRng(12));
    const guard = buildLeakGuard([tok], [], createSessionSalt());
    const o = buildOracle([tok]);
    const bad: Array<[string, ReportFormat]> = [
      [`[{"RuleID":"x","Secret":"${tok}"}, 42]`, 'gitleaks'],
      [`[{"RuleID":"x","Secret":"${tok}"`, 'gitleaks'],
      [`{"DetectorName":"Stripe","Raw":"${tok}"}\n{not json ${tok}\n`, 'trufflehog'],
      [`{"DetectorName":"Stripe"}\n`, 'trufflehog'],
    ];
    for (const [text, format] of bad) {
      let caught: unknown;
      try {
        parseReport(text, format);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ImportError);
      const e = caught as ImportError;
      expect(leakCount(e.message, o)).toBe(0);
      const out = serializeSafe({ code: e.code, message: e.message, location: e.location, count: e.count }, 'import_error', guard);
      expect(artefactLeaks(out, o)).toBe(0);
    }
  });

  it('after a simulated reload (no guard) every outbound serialisation is refused', async () => {
    const out = await runPipeline({ text: run1.gitleaksJson, format: 'gitleaks', projectSalt: SALT });
    let err: unknown;
    try {
      serializeSafe({ findings: out.findings }, 'export', NOT_READY_GUARD);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LeakGuardError);
    expect((err as LeakGuardError).reason).toBe('not_ready');
  });

  it('the guard object holds no raw material (only hashes and fixed provider prefixes)', async () => {
    const out = await runPipeline({ text: run1.gitleaksJson, format: 'gitleaks', projectSalt: SALT, files: run1.files });
    const o = buildOracle([...run1.rawOracle.reportedValues, ...run1.rawOracle.unreportedValues]);
    const fixed = new Set(prefixes);
    for (const s of walk(out.guard).strings) if (!fixed.has(s)) expect(leakCount(s, o)).toBe(0);
  });
});

describe('pipeline + policy on the synthetic traps (integration of packages A/B/C)', () => {
  const trapsOf = (s: SynthResult, out: PipelineOutput, trap: string) =>
    out.findings.filter((f) => s.labels[keyOf(f)]?.trap === trap);

  it('every finding joins to a label by (scanner, path, line, ruleId)', async () => {
    for (const format of ['gitleaks', 'trufflehog'] as const) {
      const out = await runPipeline({
        text: format === 'gitleaks' ? run1.gitleaksJson : run1.trufflehogNdjson, format, projectSalt: SALT, files: run1.files,
      });
      for (const f of out.findings) expect(run1.labels[keyOf(f)]).toBeDefined();
    }
  });

  it('T13 and T18 (Verified:true) are keep; T14 (Verified:false) is never treated as verified', async () => {
    const out = await runPipeline({ text: run1.trufflehogNdjson, format: 'trufflehog', projectSalt: SALT, files: run1.files });
    for (const t of ['T13', 'T18']) {
      const fs = trapsOf(run1, out, t);
      expect(fs.length).toBeGreaterThan(0);
      for (const f of fs) {
        expect(f.verified).toBe('verified');
        expect(decide(f, null, thresholds, hp).band).toBe('keep');
      }
    }
    for (const f of trapsOf(run1, out, 'T14')) expect(f.verified).toBe('unknown');
  });

  it('T10 is flagged and reviewed with folder context; T06/T09/T13/T18 are never dismissed', async () => {
    const outs = await Promise.all((['gitleaks', 'trufflehog'] as const).map((format) => runPipeline({
      text: format === 'gitleaks' ? run1.gitleaksJson : run1.trufflehogNdjson, format, projectSalt: SALT, files: run1.files,
    })));
    const t10 = outs.flatMap((o) => trapsOf(run1, o, 'T10'));
    expect(t10.length).toBeGreaterThan(0);
    for (const f of t10) {
      expect(f.flags.injection).toBe(true);
      expect(decide(f, null, thresholds, hp).band).toBe('review');
    }
    for (const o of outs) {
      for (const t of ['T06', 'T09', 'T13', 'T18']) {
        for (const f of trapsOf(run1, o, t)) {
          const view = buildMaskedView(f);
          const j = view === null ? null : await judge.judge(view);
          expect(decide(f, j, thresholds, hp).band).not.toBe('dismiss');
        }
      }
    }
  });

  it('T01 documented example keys are suggested dismissals from the match line alone', async () => {
    const out = await runPipeline({ text: run1.gitleaksJson, format: 'gitleaks', projectSalt: SALT });
    const t01 = trapsOf(run1, out, 'T01');
    expect(t01.length).toBeGreaterThan(0);
    for (const f of t01) expect(decide(f, null, thresholds, hp).band).toBe('dismiss');
  });
});
