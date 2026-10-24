// Judge validation (enum, range, finite, citations in/out of window, optional for Jev-style), retry once then failed,
// free text escape / cap / leak-guard re-check, masked view builders and the prompt fingerprint.
import { describe, expect, it } from 'vitest';
import type { Finding, MaskedLine, Signal } from '../../src/core/finding.ts';
import { ZERO_FLAGS } from '../../src/core/finding.ts';
import { LeakGuardError, NOT_READY_GUARD, unsafeMarkSafe } from '../../src/core/safe.ts';
import type { LeakGuard } from '../../src/core/safe.ts';
import { MAX_MODEL_TEXT_CHARS, MAX_VIEW_BYTES, REASON_CODES } from '../../src/core/judge/contract.ts';
import type { JudgeUsage, MaskedView, RawJudgeCaller, RawJudgeRequest } from '../../src/core/judge/contract.ts';
import { JUDGE_OUTPUT_SCHEMA, JUDGE_SCHEMA_VERSION } from '../../src/core/judge/schema.ts';
import { isInvalid, judgeWithRetry, tolerantParse, validateJudgeOutput } from '../../src/core/judge/validate.ts';
import { buildLlmOnlyView, buildMaskedView, viewBytes } from '../../src/core/judge/views.ts';
import { fingerprintOf, promptFingerprint } from '../../src/core/judge/fingerprint.ts';
import { PROMPT_TEMPLATE, renderPrompt } from '../../src/core/judge/prompt.ts';

const MARK = ['LEAK', 'MARK', '42'].join('');
const guard: LeakGuard = {
  ready: true,
  check(text: string, boundary) {
    if (text.includes(MARK)) throw new LeakGuardError(boundary);
  },
  exemptDigests: () => 0,
};

function line(id: string, text: string): MaskedLine {
  return { lineId: id, text: unsafeMarkSafe(text) };
}

const SIG: Signal = { id: 'S-F5', name: 'placeholder_word', direction: 'fp', strength: 'strong', evidence: { kind: 'span', lineId: 'L0', start: 4, end: 12 } };

function finding(window: MaskedLine[], over: Partial<Finding> = {}): Finding {
  return {
    id: 'c'.repeat(64), scanner: 'gitleaks', origin: 'gitleaks', ruleId: 'generic-api-key', path: 'private/area/src/app.ts', line: 10,
    maskedValue: unsafeMarkSafe('********'), length: 8, charClass: 'alnum', verified: 'unknown', verifiedLabel: 'unknown',
    valueTag: 'd'.repeat(64),
    features: { length: 8, charClass: 'alnum', entropy: 2.5, lengthBucket: 's', entropyBucket: 'low', pathClass: 'source' },
    signals: [SIG], flags: { ...ZERO_FLAGS }, maskedWindow: window, ...over,
  };
}

const WINDOW = [line('L-1', 'function f() {'), line('L0', 'key = "********"'), line('L+1', '}')];
const VIEW = buildMaskedView(finding(WINDOW)) as MaskedView;
const OK = { p_real: 0.2, reason_code: 'placeholder', cited_lines: ['L0'] };

function v(raw: unknown, citationsRequired = true) {
  return validateJudgeOutput(raw, VIEW, { citationsRequired }, guard, { provider: 'test', modelId: 'm1', usage: { calls: 1, inputTokens: 1, outputTokens: 1, usd: 0 } });
}

describe('tolerant parse', () => {
  it('accepts an object, fenced JSON and an object wrapped in prose', () => {
    expect(isInvalid(tolerantParse(OK))).toBe(false);
    expect(isInvalid(tolerantParse('```json\n' + JSON.stringify(OK) + '\n```'))).toBe(false);
    expect(isInvalid(tolerantParse('Sure. ' + JSON.stringify(OK) + ' Hope that helps {x}'))).toBe(false);
  });
  it('rejects non-JSON and arrays, without echoing the input', () => {
    const r = tolerantParse('not json at all ' + MARK);
    expect(isInvalid(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(MARK);
    expect(isInvalid(tolerantParse('[1,2]'))).toBe(true);
    expect(isInvalid(tolerantParse(42))).toBe(true);
  });
});

describe('strict validation', () => {
  it('accepts a valid output', () => {
    const r = v(OK);
    expect(isInvalid(r)).toBe(false);
    if (!isInvalid(r)) {
      expect(r).toMatchObject({ status: 'ok', p_real: 0.2, reason_code: 'placeholder', cited_lines: ['L0'], provider: 'test', modelId: 'm1' });
    }
  });
  it('reason_code must be in the fixed enum (Jev "other" is mapped by the adapter, not accepted here)', () => {
    expect(isInvalid(v({ ...OK, reason_code: 'other' }))).toBe(true);
    expect(isInvalid(v({ ...OK, reason_code: 'maybe' }))).toBe(true);
    for (const rc of REASON_CODES) expect(isInvalid(v({ ...OK, reason_code: rc }))).toBe(false);
  });
  it('p_real must be a finite number in [0, 1]', () => {
    for (const p of [1.5, -0.01, '0.5', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isInvalid(v({ ...OK, p_real: p }))).toBe(true);
    }
    expect(isInvalid(v('{"p_real": 1e999, "reason_code": "looks_real", "cited_lines": ["L0"]}'))).toBe(true);
    expect(isInvalid(v({ ...OK, p_real: 0 }))).toBe(false);
    expect(isInvalid(v({ ...OK, p_real: 1 }))).toBe(false);
  });
  it('unexpected keys are rejected', () => {
    expect(isInvalid(v({ ...OK, verdict: 'dismiss' }))).toBe(true);
  });
  it('cited lines must be inside the supplied window', () => {
    expect(isInvalid(v({ ...OK, cited_lines: ['L-1', 'L0', 'L+1'] }))).toBe(false);
    expect(isInvalid(v({ ...OK, cited_lines: ['L+3'] }))).toBe(true);
    expect(isInvalid(v({ ...OK, cited_lines: ['line 2'] }))).toBe(true);
    expect(isInvalid(v({ ...OK, cited_lines: 'L0' }))).toBe(true);
  });
  it('citations required for generative adapters, optional for Jev-style (shown as "not provided")', () => {
    const noCite = { p_real: 0.2, reason_code: 'placeholder' };
    expect(isInvalid(v(noCite, true))).toBe(true);
    expect(isInvalid(v({ ...noCite, cited_lines: [] }, true))).toBe(true);
    const r = v(noCite, false);
    expect(isInvalid(r)).toBe(false);
    if (!isInvalid(r)) expect(r.cited_lines).toBeUndefined();
  });
  it('free text is escaped, labelled model-authored and capped at 200 characters', () => {
    const r = v({ ...OK, model_text: '<img src=x onerror="alert(1)"> & `cmd`' });
    expect(isInvalid(r)).toBe(false);
    if (!isInvalid(r)) {
      expect(r.model_text).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#96;cmd&#96;');
      expect(r.model_text_label).toBe('model-authored');
    }
    const long = v({ ...OK, model_text: 'a'.repeat(500) });
    if (isInvalid(long)) throw new Error('expected valid');
    expect(Array.from(long.model_text as string).length).toBeLessThanOrEqual(200);
  });
  it('free text that fails the leak guard makes the output invalid', () => {
    expect(isInvalid(v({ ...OK, model_text: `the key is ${MARK}` }))).toBe(true);
    const r = validateJudgeOutput({ ...OK, model_text: 'hello' }, VIEW, { citationsRequired: true }, NOT_READY_GUARD);
    expect(isInvalid(r)).toBe(true);
  });

  // what_bug_this_catches: capping the unescaped input allowed an emitted 1000-character field made of ampersands.
  it('caps the final escaped text without splitting entities or Unicode, then checks exactly that text', () => {
    for (const input of ['&'.repeat(200), '"\'<>`'.repeat(100), '😀'.repeat(200), '&😀"<>'.repeat(100)]) {
      const checked: string[] = [];
      const recordingGuard: LeakGuard = { ready: true, check: (text) => { checked.push(text); }, exemptDigests: () => 0 };
      const r = validateJudgeOutput({ ...OK, model_text: input }, VIEW, { citationsRequired: true }, recordingGuard);
      expect(isInvalid(r)).toBe(false);
      if (isInvalid(r)) throw new Error('expected valid escaped text');
      const text = r.model_text as string;
      expect(text.length).toBeLessThanOrEqual(MAX_MODEL_TEXT_CHARS);
      expect(text.endsWith('…')).toBe(true);
      expect(r.model_text_label).toBe('model-authored');
      expect(checked).toEqual([text]);
      const plain = text.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, '');
      expect(plain).not.toMatch(/[&<>"'`]/);
      expect(plain).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
  it('schema enum matches the contract enum', () => {
    expect(JUDGE_OUTPUT_SCHEMA.properties.reason_code.enum).toEqual([...REASON_CODES]);
    expect(JUDGE_SCHEMA_VERSION).toBe('judge-output-v1');
  });
});

describe('judgeWithRetry', () => {
  const USAGE: JudgeUsage = { calls: 1, inputTokens: 100, outputTokens: 20, usd: 0.001 };
  function caller(outputs: unknown[], opts: { citationsRequired?: boolean; throwAt?: number } = {}) {
    const calls: RawJudgeRequest[] = [];
    const c: RawJudgeCaller = {
      id: 'test-caller', provider: 'test', modelId: 'm1', citationsRequired: opts.citationsRequired ?? true,
      async call(req) {
        calls.push(req);
        if (opts.throwAt === req.attempt) throw new Error('boom ' + MARK);
        return { output: outputs[req.attempt - 1], usage: USAGE };
      },
    };
    return { c, calls };
  }

  it('valid first time -> one call', async () => {
    const { c, calls } = caller([OK]);
    const r = await judgeWithRetry(c, VIEW, guard);
    expect(r.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toBe(JSON.stringify(VIEW));
  });
  it('invalid then valid -> ok after exactly one retry, usage summed', async () => {
    const { c, calls } = caller(['garbage', OK]);
    const r = await judgeWithRetry(c, VIEW, guard);
    expect(r.status).toBe('ok');
    expect(calls.map((x) => x.attempt)).toEqual([1, 2]);
    expect(r.usage.calls).toBe(2);
    expect(r.usage.usd).toBeCloseTo(0.002, 10);
  });
  it('invalid twice -> failed, never a third call', async () => {
    const { c, calls } = caller([{ ...OK, cited_lines: ['L+9'] }, { ...OK, p_real: 7 }]);
    const r = await judgeWithRetry(c, VIEW, guard);
    expect(r).toMatchObject({ status: 'failed', failure: 'invalid_output' });
    expect(Number.isNaN(r.p_real)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(r.usage.calls).toBe(2);
  });
  it('provider error -> failed immediately (no free retry), error text never surfaces', async () => {
    const { c, calls } = caller([OK, OK], { throwAt: 1 });
    const r = await judgeWithRetry(c, VIEW, guard);
    expect(r).toMatchObject({ status: 'failed', failure: 'provider_error' });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(MARK);
  });
  it('a view that fails the leak guard is never sent', async () => {
    const leaky = buildMaskedView(finding([line('L0', `key = ${MARK}`)])) as MaskedView;
    const { c, calls } = caller([OK]);
    expect(await judgeWithRetry(c, leaky, guard)).toMatchObject({ status: 'failed', failure: 'leak_guard' });
    expect(await judgeWithRetry(c, VIEW, NOT_READY_GUARD)).toMatchObject({ status: 'failed', failure: 'leak_guard' });
    expect(calls).toHaveLength(0);
  });
});

describe('masked views', () => {
  it('pipeline view carries basename only, window, buckets and fits in 4 KiB', () => {
    expect(VIEW.basename).toBe('app.ts');
    expect(JSON.stringify(VIEW)).not.toContain('private/area');
    expect(VIEW.maskedLine).toBe('key = "********"');
    expect(VIEW.signalBuckets).toEqual(['S-F5:fp:strong']);
    expect(VIEW.maskedWindow.map((l) => l.lineId)).toEqual(['L-1', 'L0', 'L+1']);
    expect(viewBytes(VIEW)).toBeLessThanOrEqual(MAX_VIEW_BYTES);
  });
  it('oversized windows shrink line by line, farthest from L0 first', () => {
    const big = ['L-3', 'L-2', 'L-1', 'L0', 'L+1', 'L+2', 'L+3'].map((id) => line(id, '*'.repeat(900)));
    const view = buildMaskedView(finding(big)) as MaskedView;
    expect(view).not.toBeNull();
    expect(viewBytes(view)).toBeLessThanOrEqual(MAX_VIEW_BYTES);
    const ids = view.maskedWindow.map((l) => l.lineId);
    expect(ids).toContain('L0');
    expect(ids).not.toContain('L-3');
    expect(ids).not.toContain('L+3');
  });
  it('returns null when even the match line alone exceeds 4 KiB (caller routes to review)', () => {
    expect(buildMaskedView(finding([line('L0', '*'.repeat(5000))]))).toBeNull();
  });
  it('LLM-only view: +/-1 line, no signal buckets', () => {
    const wide = ['L-3', 'L-2', 'L-1', 'L0', 'L+1', 'L+2', 'L+3'].map((id) => line(id, 'x'));
    const view = buildLlmOnlyView(finding(wide)) as MaskedView;
    expect(view.maskedWindow.map((l) => l.lineId)).toEqual(['L-1', 'L0', 'L+1']);
    expect(view.signalBuckets).toEqual([]);
  });
});

describe('prompt fingerprint', () => {
  it('is 64 lowercase hex, stable, and changes with the template', async () => {
    const a = await promptFingerprint();
    const b = await promptFingerprint();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    const c = await fingerprintOf(PROMPT_TEMPLATE + ' ', JUDGE_SCHEMA_VERSION, JUDGE_OUTPUT_SCHEMA);
    const d = await fingerprintOf(PROMPT_TEMPLATE, 'judge-output-v2', JUDGE_OUTPUT_SCHEMA);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
  });
  it('renders the guard-checked view body into the user message only', () => {
    const body = JSON.stringify(VIEW);
    const p = renderPrompt(body);
    expect(p.user).toContain(body);
    expect(p.system).not.toContain(body);
  });
});
