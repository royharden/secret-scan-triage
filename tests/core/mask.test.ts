import { describe, expect, it } from 'vitest';
import prefixConfig from '../../config/prefixes.json';
import {
  keptPrefixFor,
  loadPrefixConfig,
  maskValue,
  matchProviderFormat,
  prefixStrings,
  safeBasename,
} from '../../src/core/mask/mask.ts';
import { findCredentialTokens, isCredentialLikeToken } from '../../src/core/mask/tokens.ts';
import { MAX_MASKABLE_LINE_CHARS, buildReportMatcher } from '../../src/core/mask/reportMatcher.ts';
import { buildLeakGuard, createSessionSalt } from '../../src/core/mask/leakIndex.ts';
import { LeakGuardError } from '../../src/core/safe.ts';
import {
  containsRawMaterial,
  fakeAwsKeyId,
  fakeGenericToken,
  fakeGithubClassic,
  fakeGithubFineGrained,
  rng,
} from './_helpers.ts';

const r = rng(202);
const specs = loadPrefixConfig(prefixConfig);
const prefixes = prefixStrings(specs);

describe('prefix config', () => {
  it('loads the shipped fixed list', () => {
    expect(prefixes).toContain('AKIA');
    expect(prefixes).toContain(['gh', 'p_'].join(''));
    expect(prefixes).toContain(['github', '_pat_'].join(''));
    expect(specs.every((s) => typeof s.prefix === 'string' && s.prefix.length > 0)).toBe(true);
  });

  it('rejects invalid entries', () => {
    expect(() => loadPrefixConfig({ prefixes: [{ prefix: '' }] })).toThrow();
    expect(() => loadPrefixConfig([{ prefix: 'ab_' }, { prefix: 'ab_' }])).toThrow();
    expect(() => loadPrefixConfig([{ prefix: 'ab_', length: 3 }])).toThrow();
    expect(() => loadPrefixConfig([{ prefix: 'ab_', charset: '\\' }])).toThrow();
    expect(() => loadPrefixConfig('nope')).toThrow();
  });
});

describe('maskValue', () => {
  it('keeps a listed prefix at the value start; everything else is "*"; shape preserved', () => {
    const aws = fakeAwsKeyId(r);
    const m = maskValue(aws, prefixes);
    expect(m.keptPrefix).toBe('AKIA');
    expect(m.masked).toBe('AKIA' + '*'.repeat(aws.length - 4));
    expect(m.masked.length).toBe(aws.length);
  });

  it('keeps nothing for a prefix that is not on the list', () => {
    const v = ['zz', '_'].join('') + fakeGenericToken(r, 30);
    const m = maskValue(v, prefixes);
    expect(m.keptPrefix).toBeUndefined();
    expect('keptPrefix' in m).toBe(false);
    expect(m.masked).toBe('*'.repeat(v.length));
  });

  it('keeps nothing when the listed prefix is not at the start', () => {
    const v = 'x' + fakeGithubClassic(r);
    expect(maskValue(v, prefixes).masked).toBe('*'.repeat(v.length));
    expect(keptPrefixFor(v, prefixes)).toBeUndefined();
  });

  it('masks the prefix too when too few characters would remain masked', () => {
    const v = ['gh', 'p_'].join('') + 'ab';
    expect(maskValue(v, prefixes).masked).toBe('******');
  });

  it('chooses the longest listed prefix', () => {
    const fg = fakeGithubFineGrained(r);
    expect(maskValue(fg, ['github_', ['github', '_pat_'].join('')]).keptPrefix).toBe(['github', '_pat_'].join(''));
  });

  it('matchProviderFormat checks prefix, length and charset (S-R3 helper)', () => {
    const aws = fakeAwsKeyId(r);
    expect(matchProviderFormat(aws, specs)?.prefix).toBe('AKIA');
    expect(matchProviderFormat(aws + 'Z', specs)).toBeUndefined();
    expect(matchProviderFormat(aws.slice(0, 19) + 'a', specs)).toBeUndefined();
  });

  it('safeBasename keeps the text after the last / or backslash (judge views use it for MaskedView.basename)', () => {
    expect(safeBasename('src/a/b.ts')).toBe('b.ts');
    expect(safeBasename('src\\a\\c.ts')).toBe('c.ts');
    expect(safeBasename('plain.ts')).toBe('plain.ts');
    expect(safeBasename('dir/')).toBe('');
    expect(safeBasename('[path withheld]')).toBe('[path withheld]');
  });
});

describe('findCredentialTokens', () => {
  it('finds known-prefix and generic high-entropy tokens with exact spans', () => {
    const gh = fakeGithubClassic(r);
    const generic = fakeGenericToken(r, 40);
    const aws = fakeAwsKeyId(r);
    const line = `const a = "${gh}"; const b = '${generic}'; key=${aws}`;
    const found = findCredentialTokens(line).map((t) => t.value);
    expect(found).toContain(gh);
    expect(found).toContain(generic);
    expect(found).toContain(aws);
    for (const t of findCredentialTokens(line)) expect(line.slice(t.start, t.end)).toBe(t.value);
  });

  it('does not flag words, identifiers, paths, repeated or digit-only runs', () => {
    for (const s of [
      'internationalization_configuration_value',
      'getUserAccountSettingsForAdministrator',
      'src/components/forms/LoginButton',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '12345678901234567890',
      'MAX_CONNECTION_RETRY_COUNT_DEFAULT',
    ]) {
      expect(isCredentialLikeToken(s)).toBe(false);
      expect(findCredentialTokens(`value = ${s};`)).toEqual([]);
    }
  });
});

describe('report matcher', () => {
  it('masks every known value and unreported tokens in a line, keeping listed prefixes at value start', () => {
    const gh = fakeGithubClassic(r);
    const aws = fakeAwsKeyId(r);
    const unreported = fakeGenericToken(r, 40);
    const m = buildReportMatcher([gh, aws], prefixes);
    const line = `GH=${gh} AWS=${aws} other=${unreported}`;
    const res = m.maskLine(line);
    expect('text' in res).toBe(true);
    if (!('text' in res)) return;
    expect(res.text.length).toBe(line.length);
    for (const v of [gh, aws, unreported]) expect(containsRawMaterial(res.text, v)).toBe(false);
    expect(res.text).toContain('GH=' + ['gh', 'p_'].join('') + '*');
    expect(res.text).toContain('AWS=AKIA****');
    expect(res.text).toContain('other=' + '*'.repeat(40));
    expect(m.knownValues()).toContain(unreported);
  });

  it('keeps a long kept prefix only at a token boundary', () => {
    const fg = fakeGithubFineGrained(r);
    const kept = ['github', '_pat_'].join('');
    const m = buildReportMatcher([fg], prefixes);
    const a = m.maskLine(`t: ${fg}`);
    const b = m.maskLine(`x${fg}`);
    expect('text' in a && a.text).toBe(`t: ${kept}` + '*'.repeat(fg.length - kept.length));
    // Not at a token boundary: the prefix is masked too ('x' itself may be masked as part of a detected token).
    expect('text' in b && b.text.slice(1)).toBe('*'.repeat(fg.length));
  });

  it('masks partial occurrences of a known value (any 6-gram)', () => {
    const gh = fakeGithubClassic(r);
    const m = buildReportMatcher([gh], prefixes);
    const part = gh.slice(10, 22);
    const res = m.maskLine(`wrapped: ${part} end`);
    expect('text' in res).toBe(true);
    if ('text' in res) expect(containsRawMaterial(res.text, part)).toBe(false);
  });

  it('masks short values only at token boundaries', () => {
    const short = ['Qz', '7x'].join('');
    const m = buildReportMatcher([short], prefixes);
    const a = m.maskLine(`pw=${short};`);
    const b = m.maskLine(`a${short}b`);
    expect('text' in a && a.text).toBe('pw=****;');
    expect('text' in b && b.text).toBe(`a${short}b`);
  });

  // what_bug_this_catches: one/two-character report secrets, including JSON-escaped punctuation, left context intact.
  it('redacts every nonempty short value, including one and two characters', () => {
    for (const short of ['Q', 'Q7', '"\\', '\u001f']) {
      const matcher = buildReportMatcher([short], prefixes);
      expect(matcher.knownValues()).toContain(short);
      const line = `pin='${short}'; path=keys/${short}/scan.txt`;
      const masked = matcher.maskLine(line);
      expect('text' in masked && masked.text).toBe(`pin='${'*'.repeat(short.length)}'; path=keys/${'*'.repeat(short.length)}/scan.txt`);
      const embedded = matcher.maskLine(`x${short}x`);
      expect('text' in embedded && embedded.text).toBe(`x${short}x`);
    }
    // A mask-only one-character value cannot be safely represented by the mask character: omit the line.
    expect(buildReportMatcher(['*'], prefixes).maskLine('pin=*')).toEqual({ unmaskable: true });
  });

  it('a placeholder value made of mask characters does not mask ordinary lines', () => {
    const m = buildReportMatcher(['********', fakeGithubClassic(r)], prefixes);
    const res = m.maskLine('hello world, nothing secret here');
    expect('text' in res && res.text).toBe('hello world, nothing secret here');
  });

  it('returns unmaskable for a line it refuses to process', () => {
    const m = buildReportMatcher([fakeGithubClassic(r)], prefixes);
    expect(m.maskLine('a'.repeat(MAX_MASKABLE_LINE_CHARS + 1))).toEqual({ unmaskable: true });
  });

  it('masked output passes a leak guard built from knownValues/keptPrefixes; raw input does not', () => {
    const gh = fakeGithubClassic(r);
    const fg = fakeGithubFineGrained(r);
    const m = buildReportMatcher([gh, fg], prefixes);
    const line = `a=${gh} b=${fg} c=${fakeGenericToken(r, 32)}`;
    const res = m.maskLine(line);
    expect('text' in res).toBe(true);
    const guard = buildLeakGuard(m.knownValues(), m.keptPrefixes(), createSessionSalt());
    if ('text' in res) expect(() => guard.check(res.text, 'export')).not.toThrow();
    expect(() => guard.check(line, 'export')).toThrow(LeakGuardError);
  });

  it('prime() learns tokens from all lines so earlier lines mask later-seen tokens', () => {
    const unreported = fakeGenericToken(r, 40);
    const m = buildReportMatcher([], prefixes);
    m.prime([`later: ${unreported}`]);
    const res = m.maskLine(`fragment ${unreported.slice(0, 12)}`);
    expect('text' in res).toBe(true);
    if ('text' in res) expect(containsRawMaterial(res.text, unreported.slice(0, 12))).toBe(false);
  });
});
