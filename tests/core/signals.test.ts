// Signals S-R1..S-R5, S-F1..S-F11: one positive and one negative fixture per id, span binding (T17), path downgrade-only.
// Every credential-shaped string is assembled from split parts / seeded random characters at run time.
import { describe, expect, it } from 'vitest';
import signalsJson from '../../config/signals.json';
import hpJson from '../../config/high-precision-rules.json';
import prefixesJson from '../../config/prefixes.json';
import thresholdsJson from '../../config/thresholds.json';
import type { CharClass, Features, Finding, PathClass, RawCandidate, Signal, SignalId } from '../../src/core/finding.ts';
import { ZERO_FLAGS } from '../../src/core/finding.ts';
import { unsafeMarkSafe } from '../../src/core/safe.ts';
import { createRng } from '../../src/core/rng.ts';
import { buildSpanContext, evaluateSignals, loadSignalConfig, SignalConfigError } from '../../src/core/signals/index.ts';
import { MAX_SPANS } from '../../src/core/signals/shapes.ts';
import { runPipeline } from '../../src/core/pipeline.ts';
import { decide, loadThresholds } from '../../src/core/policy/decide.ts';
import type { JudgeResult } from '../../src/core/judge/contract.ts';
import { TOKEN_KINDS, buildToken } from '../../src/core/synth/tokens.ts';
import { loadPrefixConfig, matchProviderFormat } from '../../src/core/mask/mask.ts';

const cfg = loadSignalConfig(signalsJson, hpJson, prefixesJson);

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;
const B64 = ALNUM + '+/';
const j = (...p: string[]): string => p.join('');

const rand = (seed: number, alphabet: string, n: number): string => createRng(seed).chars(alphabet, n);
const ghToken = (seed = 1): string => j('gh', 'p', '_') + rand(seed, ALNUM, 36);
const awsDocsKey = (): string => j('AK', 'IA', 'IOSFO', 'DNN7', 'EXA', 'MPLE');
const pemHeader = (): string => j('-----BEG', 'IN RSA PRIVATE KEY-----');
const pemFooter = (): string => j('-----EN', 'D RSA PRIVATE KEY-----');
const fullPem = (seed = 3): string => {
  const body = rand(seed, B64, 256).match(/.{1,64}/g)!.join('\n');
  return `${pemHeader()}\n${body}\n${pemFooter()}`;
};

function entropy(s: string): number {
  const m = new Map<string, number>();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of m.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClass(s: string): CharClass {
  if (s.includes('-----BEGIN')) return 'pem';
  if (/^[0-9]+$/.test(s)) return 'digits';
  if (/^[0-9a-fA-F]+$/.test(s)) return 'hex';
  if (/^[A-Za-z0-9]+$/.test(s)) return 'alnum';
  if (/^[A-Za-z0-9_-]+=*$/.test(s)) return 'base64url';
  if (/^[A-Za-z0-9+/]+=*$/.test(s)) return 'base64';
  return 'mixed';
}

function feat(value: string, pathClass: PathClass = 'source', over: Partial<Features> = {}): Features {
  return { length: value.length, charClass: charClass(value), entropy: entropy(value), lengthBucket: 'm', entropyBucket: 'mid', pathClass, ...over };
}

function raw(value: string, rawLine?: string, over: Partial<RawCandidate> = {}): RawCandidate {
  const r: RawCandidate = { scanner: 'gitleaks', ruleId: 'generic-api-key', path: 'src/app.ts', line: 3, rawValue: value, recordIndex: 0, ...over };
  if (rawLine !== undefined) r.rawLine = rawLine;
  return r;
}

function sig(value: string, line?: string, over: Partial<RawCandidate> = {}, pathClass: PathClass = 'source', f: Partial<Features> = {}): Signal[] {
  return evaluateSignals(raw(value, line, over), feat(value, pathClass, f), cfg);
}
function ids(value: string, line?: string, over: Partial<RawCandidate> = {}, pathClass: PathClass = 'source', f: Partial<Features> = {}): SignalId[] {
  return sig(value, line, over, pathClass, f).map((s) => s.id);
}

describe('config/signals.json loader', () => {
  it('loads the shipped config with all 16 signals', () => {
    expect(Object.keys(cfg.defs)).toHaveLength(16);
    expect(cfg.sentinels.size).toBeGreaterThan(0);
  });
  it('rejects a config that promotes the path signal (downgrade-only invariant)', () => {
    const bad = JSON.parse(JSON.stringify(signalsJson));
    bad.signals.find((s: { id: string }) => s.id === 'S-F11').strength = 'decisive';
    expect(() => loadSignalConfig(bad, hpJson, prefixesJson)).toThrow(SignalConfigError);
  });
  it('rejects a sentinel stored as one complete literal', () => {
    const bad = JSON.parse(JSON.stringify(signalsJson));
    bad.sentinels[0].parts = [bad.sentinels[0].parts.join('')];
    expect(() => loadSignalConfig(bad, hpJson, prefixesJson)).toThrow(SignalConfigError);
  });
});

// what_bug_this_catches: S-R3 drifting from the mask's prefix list (two sources of provider formats), or a synthetic
// token kind whose shape S-R3 does not recognise.
describe('one source of provider formats (config/prefixes.json)', () => {
  it('S-R3 formats are exactly the validated prefixes.json specs', () => {
    expect(cfg.providerFormats.map((f) => f.prefix)).toEqual(loadPrefixConfig(prefixesJson).map((s) => s.prefix));
  });
  it('rejects a stale provider_formats section in signals.json', () => {
    const bad = JSON.parse(JSON.stringify(signalsJson));
    bad.provider_formats = [{ id: 'x', pattern: '^x$' }];
    expect(() => loadSignalConfig(bad, hpJson, prefixesJson)).toThrow(SignalConfigError);
  });
  it('rejects an invalid prefixes config as a SignalConfigError', () => {
    expect(() => loadSignalConfig(signalsJson, hpJson, { prefixes: [{ prefix: '' }] })).toThrow(SignalConfigError);
    expect(() => loadSignalConfig(signalsJson, hpJson, 'nope')).toThrow(SignalConfigError);
  });
  it('S-R3 follows the prefixes config it was given (a format missing from it never fires)', () => {
    const noGithub = {
      prefixes: (prefixesJson as { prefixes: Array<{ prefix: string }> }).prefixes.filter((p) => !p.prefix.startsWith('gh')),
    };
    const c2 = loadSignalConfig(signalsJson, hpJson, noGithub);
    const tok = ghToken(13);
    expect(evaluateSignals(raw(tok), feat(tok), c2).map((s) => s.id)).not.toContain('S-R3');
    expect(ids(tok)).toContain('S-R3');
  });
  it('every synthetic TOKEN_SPECS kind matches prefixes.json and fires S-R3', () => {
    const specs = loadPrefixConfig(prefixesJson);
    for (const kind of TOKEN_KINDS) {
      for (let seed = 1; seed <= 5; seed++) {
        const tok = buildToken(kind, createRng(seed * 101));
        expect({ kind, matched: matchProviderFormat(tok, specs) !== undefined }).toEqual({ kind, matched: true });
        expect({ kind, sr3: ids(tok).includes('S-R3') }).toEqual({ kind, sr3: true });
      }
    }
  });
});

describe('real-direction signals', () => {
  it('S-R1 positive: Verified:true', () => {
    expect(ids('abc', undefined, { scanner: 'trufflehog', verifiedRaw: true })).toContain('S-R1');
  });
  it('S-R1 negative: Verified:false or missing is unknown, not evidence', () => {
    expect(ids('abc', undefined, { scanner: 'trufflehog', verifiedRaw: false })).not.toContain('S-R1');
    expect(ids('abc', undefined, { scanner: 'trufflehog' })).not.toContain('S-R1');
  });

  it('S-R2 positive: full PEM body', () => {
    const v = fullPem();
    const s = ids(v, undefined, { ruleId: 'other-rule' }, 'source', { charClass: 'pem' });
    expect(s).toContain('S-R2');
    expect(s).not.toContain('S-F4');
  });
  it('S-R2 negative: elided PEM body', () => {
    const v = `${pemHeader()}\nMIIEpAIBAAKCAQEA...\n${pemFooter()}`;
    expect(ids(v, undefined, {}, 'source', { charClass: 'pem' })).not.toContain('S-R2');
  });

  it('S-R3 positive: exact provider format', () => {
    expect(ids(ghToken())).toContain('S-R3');
  });
  it('S-R3 negative: wrong length, or prefix not at value start', () => {
    expect(ids(ghToken().slice(0, -1))).not.toContain('S-R3');
    expect(ids('x' + ghToken())).not.toContain('S-R3');
  });

  it('S-R4 positive: high-precision rule id (case-insensitive)', () => {
    expect(ids('abc', undefined, { ruleId: 'github-pat' })).toContain('S-R4');
    expect(ids('abc', undefined, { ruleId: 'GITHUB', scanner: 'trufflehog' })).toContain('S-R4');
  });
  it('S-R4 negative: generic rule', () => {
    expect(ids('abc', undefined, { ruleId: 'generic-api-key' })).not.toContain('S-R4');
  });

  it('S-R5 positive: credential keyword assigned to a high-entropy value', () => {
    const v = rand(11, ALNUM, 32);
    expect(ids(v, `api_key = "${v}"`)).toContain('S-R5');
  });
  it('S-R5 negative: low entropy, or no keyword assignment', () => {
    const low = 'aaaaaaaaaaaaaaaabbbb';
    expect(ids(low, `api_key = "${low}"`)).not.toContain('S-R5');
    const v = rand(12, ALNUM, 32);
    expect(ids(v, `color = "${v}"`)).not.toContain('S-R5');
  });
  it('S-R5 ignores scanner entropy entirely', () => {
    const low = 'aaaaaaaaaaaaaaaabbbb';
    expect(ids(low, `password = "${low}"`, { scannerEntropy: 7.9 })).not.toContain('S-R5');
  });
});

describe('decisive FP signals', () => {
  it('S-F1 positive: exact documented sentinel', () => {
    expect(ids(awsDocsKey(), undefined, { ruleId: 'aws-access-token' })).toContain('S-F1');
  });
  it('S-F1 negative: one character changed', () => {
    const v = awsDocsKey().slice(0, -1) + 'F';
    expect(ids(v, undefined, { ruleId: 'aws-access-token' })).not.toContain('S-F1');
  });

  it('S-F2 positive: span inside os.environ[...] / ${VAR}', () => {
    expect(ids('API_TOKEN', 'key = os.environ["API_TOKEN"]')).toContain('S-F2');
    expect(ids('${DB_PASSWORD}')).toContain('S-F2');
    expect(ids('process.env.GH_TOKEN', 'const t = process.env.GH_TOKEN;')).toContain('S-F2');
  });
  it('S-F2 negative (T17): literal on the same line as a reference is NOT covered', () => {
    const tok = ghToken(5);
    const line = `const token = process.env.GH_TOKEN || "${tok}";`;
    const s = ids(tok, line);
    expect(s).not.toContain('S-F2');
    expect(s).toContain('S-R3');
  });
  it('S-F2 negative: literal default inside a getenv call is not a reference', () => {
    const tok = ghToken(6);
    expect(ids(tok, `token = os.getenv("GH_TOKEN", "${tok}")`)).not.toContain('S-F2');
  });
  it('S-F2 negative: value occurring both inside and outside a reference', () => {
    expect(ids('API_TOKEN', 'API_TOKEN = os.environ["API_TOKEN"]')).not.toContain('S-F2');
  });

  it('S-F3 positive: integrity hash in a lockfile', () => {
    const v = j('sha', '512-') + rand(21, B64, 86) + '==';
    expect(ids(v, `"integrity": "${v}"`, { path: 'package-lock.json' }, 'lockfile')).toContain('S-F3');
    const body = rand(22, B64, 86);
    expect(ids(body, `"integrity": "sha512-${body}=="`, { path: 'web/package-lock.json' }, 'lockfile')).toContain('S-F3');
  });
  it('S-F3 negative: same shape outside a lockfile', () => {
    const v = j('sha', '512-') + rand(23, B64, 86) + '==';
    expect(ids(v, `"integrity": "${v}"`, { path: 'src/config.json' }, 'config')).not.toContain('S-F3');
  });

  it('S-F4 positive: PEM header with elided or empty body', () => {
    expect(ids(`${pemHeader()}\n...\n${pemFooter()}`, undefined, {}, 'source', { charClass: 'pem' })).toContain('S-F4');
    expect(ids(`${pemHeader()}\n${pemFooter()}`, undefined, {}, 'source', { charClass: 'pem' })).toContain('S-F4');
  });
  it('S-F4 negative: full PEM body; no header at all', () => {
    expect(ids(fullPem(4), undefined, {}, 'source', { charClass: 'pem' })).not.toContain('S-F4');
    expect(ids(rand(9, B64, 40))).not.toContain('S-F4');
  });
});

describe('strong and weak FP signals', () => {
  it('S-F5 positive: placeholder words / patterns', () => {
    expect(ids('changeme')).toContain('S-F5');
    expect(ids('your_api_key_here')).toContain('S-F5');
    expect(ids('xxxxxxxxxxxx')).toContain('S-F5');
  });
  it('S-F5 negative: random value', () => {
    expect(ids(rand(31, DIGITS + 'BCDFGHJKLMNPQRSTVWZ', 24))).not.toContain('S-F5');
  });

  it('S-F6 positive: UUID and 40-hex commit', () => {
    expect(ids('123e4567-e89b-12d3-a456-426614174000')).toContain('S-F6');
    expect(ids(rand(32, '0123456789abcdef', 40))).toContain('S-F6');
  });
  it('S-F6 negative: 39 hex chars', () => {
    expect(ids(rand(33, '0123456789abcdef', 39))).not.toContain('S-F6');
  });

  it('S-F7 positive: data URI value, or span inside a data URI', () => {
    const b = rand(41, B64, 60);
    expect(ids(`data:image/png;base64,${b}`)).toContain('S-F7');
    expect(ids(b, `<img src="data:image/png;base64,${b}">`)).toContain('S-F7');
  });
  it('S-F7 negative: bare base64 value', () => {
    const b = rand(42, B64, 60);
    expect(ids(b, `blob = "${b}"`)).not.toContain('S-F7');
  });

  it('S-F8 positive (T16): value equals its own variable name', () => {
    expect(ids('API_KEY', 'API_KEY = "API_KEY"')).toContain('S-F8');
    expect(ids('your_password', '"password": "your_password"')).toContain('S-F8');
  });
  it('S-F8 negative: unrelated value', () => {
    const v = rand(43, ALNUM, 24);
    expect(ids(v, `API_KEY = "${v}"`)).not.toContain('S-F8');
  });

  it('S-F9 positive: computed entropy below class threshold, even if scanner entropy is high', () => {
    expect(ids('aaaaaaaaaaaaaaaabbbb', undefined, { scannerEntropy: 6 })).toContain('S-F9');
  });
  it('S-F9 negative: high computed entropy, even if scanner entropy is 0', () => {
    expect(ids(rand(44, ALNUM, 32), undefined, { scannerEntropy: 0 })).not.toContain('S-F9');
  });

  it('S-F10 positive: camel/snake identifier', () => {
    expect(ids('getUserName')).toContain('S-F10');
    expect(ids('database_password')).toContain('S-F10');
  });
  it('S-F10 negative: random alphanumeric with digits', () => {
    expect(ids(rand(45, ALNUM, 32) + '7')).not.toContain('S-F10');
  });

  it('S-F11 positive: test/fixture/docs path, flagged downgrade-only and weak', () => {
    const s = sig(ghToken(7), undefined, { path: 'tests/auth.test.ts' }, 'test').find((x) => x.id === 'S-F11');
    expect(s).toBeDefined();
    expect(s!.downgradeOnly).toBe(true);
    expect(s!.strength).toBe('weak');
  });
  it('S-F11 negative: source path', () => {
    expect(ids(ghToken(8), undefined, { path: 'src/auth.ts' }, 'source')).not.toContain('S-F11');
  });
});

describe('span binding', () => {
  // what_bug_this_catches: the 65th occurrence was silently dropped, allowing S-F2 to dismiss a final literal.
  it('span exhaustion suppresses FP evidence and forces the final pipeline/policy outcome to review', async () => {
    const value = 'FOOBAR';
    const line = Array.from({ length: MAX_SPANS }, () => `process.env.${value}`).join(' + ') + `; b = "${value}";`;
    const span = buildSpanContext(raw(value, line));
    expect(span.spans).toHaveLength(MAX_SPANS);
    expect(span.complete).toBe(false);
    const signals = sig(value, line);
    expect(signals.map((s) => s.id)).not.toContain('S-F2');
    expect(signals.filter((s) => s.direction === 'fp')).toEqual([]);
    const out = await runPipeline({
      text: JSON.stringify([{ RuleID: 'generic', Secret: value, Line: line, File: 'src/app.ts', StartLine: 1 }]),
      format: 'gitleaks', projectSalt: new Uint8Array(32).fill(7),
    });
    const finding = out.findings[0] as Finding;
    expect(finding.flags.malformedEvidence).toBe(true);
    const dismissingJudge: JudgeResult = {
      p_real: 0, reason_code: 'test_value', usage: { calls: 1, inputTokens: 0, outputTokens: 0, usd: 0 },
      status: 'ok', provider: 'test', modelId: 'test',
    };
    const enabled = loadThresholds({ ...thresholdsJson, judge_dismiss_enabled: true });
    expect(decide(finding, dismissingJudge, enabled, []).band).toBe('review');
  });

  it('exactly the span limit is complete, and exhaustion suppresses every FP predicate', () => {
    const value = 'API_TOKEN';
    const line = Array.from({ length: MAX_SPANS }, () => `process.env.${value}`).join(' + ');
    expect(buildSpanContext(raw(value, line)).complete).toBe(true);
    expect(ids(value, line)).toContain('S-F2');
    for (const v of [awsDocsKey(), 'changeme', 'API_KEY']) {
      const repeated = Array.from({ length: MAX_SPANS + 1 }, () => `API_KEY="${v}"`).join(';');
      expect(sig(v, repeated, { path: 'docs/setup.md' }, 'docs').filter((s) => s.direction === 'fp')).toEqual([]);
    }
  });

  // what_bug_this_catches: any literal after the first PEM header inherited that block's full/elided status.
  it('unrelated literals after empty, elided or full PEM blocks receive no PEM signal and are never dismissed', async () => {
    const literal = rand(83, ALNUM, 32);
    const blocks = [
      `${pemHeader()}\\n${pemFooter()}`,
      `${pemHeader()}\\n...\\n${pemFooter()}`,
      fullPem(84).replace(/\n/g, '\\n'),
    ];
    for (const block of blocks) {
      const line = `const pem = "${block}"; const other = "${literal}";`;
      const signals = sig(literal, line);
      expect(signals.map((s) => s.id)).not.toContain('S-F4');
      expect(signals.map((s) => s.id)).not.toContain('S-R2');
      const out = await runPipeline({
        text: JSON.stringify([{ RuleID: 'generic', Secret: literal, Line: line, File: 'src/app.ts', StartLine: 1 }]),
        format: 'gitleaks', projectSalt: new Uint8Array(32).fill(9),
      });
      expect(decide(out.findings[0] as Finding, null, loadThresholds(thresholdsJson), []).band).toBe('review');
    }
  });

  it('PEM body spans bind to their own matching block when several blocks share a line', () => {
    const body = rand(85, B64, 80);
    const short = rand(86, ALNUM, 12);
    const line = `a="${pemHeader()}\\n...\\n${pemFooter()}"; b="${pemHeader()}\\n${body}\\n${pemFooter()}";`;
    expect(ids(body, line)).toContain('S-R2');
    expect(ids(body, line)).not.toContain('S-F4');
    expect(ids('...', line)).toContain('S-F4');
    expect(ids('...', line)).not.toContain('S-R2');
    const two = `a="${pemHeader()}\\n...\\n${pemFooter()}"; b="${pemHeader()}\\n${short}\\n${pemFooter()}";`;
    expect(ids(short, two)).toContain('S-F4');
    // An occurrence outside the block prevents decisive FP evidence for that same value.
    expect(ids(short, two + `; c="${short}"`)).not.toContain('S-F4');
    expect(ids(body, `a="${pemHeader()}\\n${body}`)).not.toContain('S-R2');
    expect(ids(short, `a="${pemHeader()}\\n${short}`)).not.toContain('S-F4');
    const mismatched = `${pemHeader()}\\n...\\n${j('-----EN', 'D EC PRIVATE KEY-----')}`;
    expect(ids(mismatched)).not.toContain('S-F4');
  });

  it('evidence points at the finding span on L0', () => {
    const tok = ghToken(9);
    const line = `token = "${tok}"`;
    for (const s of sig(tok, line)) {
      expect(s.evidence.lineId).toBe('L0');
      expect(s.evidence.kind).toBe('span');
      expect(s.evidence.start).toBe(line.indexOf(tok));
      expect(s.evidence.end).toBe(line.indexOf(tok) + tok.length);
    }
  });
  it('falls back to a line pointer when the value is not on the line', () => {
    const s = sig('changeme', 'nothing here');
    expect(s.find((x) => x.id === 'S-F5')!.evidence).toEqual({ kind: 'line', lineId: 'L0' });
  });
  it('signals come back in canonical order, each at most once', () => {
    const s = ids(awsDocsKey(), `aws_access_key_id = "${awsDocsKey()}"`, { ruleId: 'aws-access-token' });
    expect(new Set(s).size).toBe(s.length);
    expect(s.indexOf('S-R3')).toBeLessThan(s.indexOf('S-F1'));
  });
});

describe('path class is downgrade only', () => {
  const t = loadThresholds({ ...thresholdsJson, judge_dismiss_enabled: true });
  function finding(signals: Signal[]): Finding {
    const v = 'v';
    return {
      id: 'f'.repeat(64), scanner: 'gitleaks', origin: 'gitleaks', ruleId: 'generic-api-key', path: 'tests/a.ts', line: 1,
      maskedValue: unsafeMarkSafe('****'), length: 4, charClass: 'alnum', verified: 'unknown', verifiedLabel: 'unknown',
      valueTag: '0'.repeat(64), features: feat(v, 'test'), signals, flags: { ...ZERO_FLAGS }, maskedWindow: [],
    };
  }
  const judge = (p: number): JudgeResult => ({
    p_real: p, reason_code: p >= 0.5 ? 'looks_real' : 'test_value', usage: { calls: 1, inputTokens: 0, outputTokens: 0, usd: 0 },
    status: 'ok', provider: 'test', modelId: 'test',
  });

  it('adding S-F11 never turns a non-dismiss band into dismiss, and only ever moves keep -> review', () => {
    const tok = ghToken(10);
    const base = sig(tok, undefined, { path: 'src/a.ts' }, 'source');
    const withPath = sig(tok, undefined, { path: 'tests/a.ts' }, 'test');
    expect(withPath.map((s) => s.id)).toContain('S-F11');
    for (const p of [0, 0.05, 0.1, 0.3, 0.5, 0.69, 0.7, 0.9, 1]) {
      const a = decide(finding(base), judge(p), t, cfg.highPrecisionRules).band;
      const b = decide(finding(withPath), judge(p), t, cfg.highPrecisionRules).band;
      if (a !== 'dismiss') expect(b).not.toBe('dismiss');
      if (a !== b) expect([a, b]).toEqual(['keep', 'review']);
    }
  });
  it('S-F11 alone never produces a stage-1 dismissal', () => {
    const s = sig(rand(50, ALNUM, 30), undefined, { path: 'docs/setup.md' }, 'docs');
    expect(decide(finding(s), null, t, []).band).toBe('review');
  });
});
