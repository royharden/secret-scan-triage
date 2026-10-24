import { describe, expect, it } from 'vitest';
import prefixConfig from '../../config/prefixes.json';
import type { RawCandidate } from '../../src/core/finding.ts';
import type { SafeText } from '../../src/core/safe.ts';
import { matchPathSuffix, normalizeReportPath } from '../../src/core/context/pathMatch.ts';
import {
  CONTEXT_FILE_MAX_BYTES,
  MAX_LINE_CHARS,
  MAX_WINDOW_LINES,
  buildWindow,
  isContextFileTooLarge,
  lineIdFor,
  splitFileLines,
} from '../../src/core/context/window.ts';
import { isContextMismatch, valueOccursInLines } from '../../src/core/context/mismatch.ts';
import { buildReportMatcher } from '../../src/core/mask/reportMatcher.ts';
import type { ReportMatcher } from '../../src/core/mask/reportMatcher.ts';
import { loadPrefixConfig, prefixStrings } from '../../src/core/mask/mask.ts';
import { containsRawMaterial, fakeGenericToken, fakeGithubClassic, rng } from './_helpers.ts';

const r = rng(404);
const prefixes = prefixStrings(loadPrefixConfig(prefixConfig));

describe('normalizeReportPath', () => {
  it('normalises separators, dot segments, leading slashes and drive letters', () => {
    expect(normalizeReportPath('src\\a\\b.ts')).toBe('src/a/b.ts');
    expect(normalizeReportPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeReportPath('C:\\repo\\src\\a.ts')).toBe('repo/src/a.ts');
    expect(normalizeReportPath('/home/u/repo/a.ts')).toBe('home/u/repo/a.ts');
    expect(normalizeReportPath('a/./b//c.ts')).toBe('a/b/c.ts');
  });

  it('rejects traversal and unsafe names', () => {
    expect(normalizeReportPath('../etc/passwd')).toBeNull();
    expect(normalizeReportPath('a/../../b')).toBeNull();
    expect(normalizeReportPath('a\u0000b')).toBeNull();
    expect(normalizeReportPath('')).toBeNull();
    expect(normalizeReportPath('file:///etc/x')).toBeNull();
    expect(normalizeReportPath('a/b.txt:stream')).toBeNull();
    expect(normalizeReportPath('/')).toBeNull();
  });
});

describe('matchPathSuffix', () => {
  const files = ['repo/src/app.ts', 'repo/test/app.ts', 'repo/README.md'];

  it('picks the longest unique suffix match and returns the entry as given', () => {
    expect(matchPathSuffix('src/app.ts', files)).toBe('repo/src/app.ts');
    expect(matchPathSuffix('/home/runner/work/repo/src/app.ts', files)).toBe('repo/src/app.ts');
    expect(matchPathSuffix('README.md', files)).toBe('repo/README.md');
  });

  it('refuses ambiguity, unsafe report paths and no match', () => {
    expect(matchPathSuffix('app.ts', files)).toBe('ambiguous');
    expect(matchPathSuffix('../src/app.ts', files)).toBeNull();
    expect(matchPathSuffix('lib/other.ts', files)).toBeNull();
    expect(matchPathSuffix('src/app.ts', [])).toBeNull();
  });
});

function candidate(rawValue: string, line: number, rawLine: string): RawCandidate {
  return { scanner: 'gitleaks', ruleId: 'generic-api-key', path: 'src/app.ts', line, rawValue, rawLine, recordIndex: 0 };
}

function fileWith(secret: string, at: number, total = 10): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= total; i++) lines.push(i === at ? `TOKEN = "${secret}"` : `line ${i}`);
  return lines;
}

describe('buildWindow', () => {
  it('builds ±3 masked lines around the reported line', () => {
    const secret = fakeGithubClassic(r);
    const matcher = buildReportMatcher([secret], prefixes);
    const w = buildWindow(fileWith(secret, 5), candidate(secret, 5, `TOKEN = "${secret}"`), matcher);
    expect(w.mismatch).toBe(false);
    expect(w.unmaskable).toBe(false);
    expect(w.lines.map((l) => l.lineId)).toEqual(['L-3', 'L-2', 'L-1', 'L0', 'L+1', 'L+2', 'L+3']);
    for (const l of w.lines) expect(containsRawMaterial(l.text, secret)).toBe(false);
    expect(w.lines[3].text.startsWith('TOKEN = "')).toBe(true);
  });

  it('clamps the radius (hard max 7 lines) and trims at file edges', () => {
    const secret = fakeGithubClassic(r);
    const matcher = buildReportMatcher([secret], prefixes);
    const big = buildWindow(fileWith(secret, 5), candidate(secret, 5, ''), matcher, 10);
    expect(big.lines.length).toBeLessThanOrEqual(MAX_WINDOW_LINES);
    const one = buildWindow(fileWith(secret, 5), candidate(secret, 5, ''), matcher, 1);
    expect(one.lines.map((l) => l.lineId)).toEqual(['L-1', 'L0', 'L+1']);
    const edge = buildWindow(fileWith(secret, 1), candidate(secret, 1, ''), matcher);
    expect(edge.lines.map((l) => l.lineId)).toEqual(['L0', 'L+1', 'L+2', 'L+3']);
  });

  it('falls back to the match line with a mismatch flag when the value is not in the window', () => {
    const secret = fakeGithubClassic(r);
    const matcher = buildReportMatcher([secret], prefixes);
    const rawLine = `TOKEN = "${secret}"`;
    const w = buildWindow(fileWith(secret, 2), candidate(secret, 9, rawLine), matcher);
    expect(w.mismatch).toBe(true);
    expect(w.lines.map((l) => l.lineId)).toEqual(['L0']);
    expect(containsRawMaterial(w.lines[0].text, secret)).toBe(false);
    const outOfRange = buildWindow(fileWith(secret, 2), candidate(secret, 50, rawLine), matcher);
    expect(outOfRange.mismatch).toBe(true);
  });

  it('without file context uses the match line only', () => {
    const secret = fakeGithubClassic(r);
    const matcher = buildReportMatcher([secret], prefixes);
    const w = buildWindow(null, candidate(secret, 5, `k = ${secret}`), matcher);
    expect(w.mismatch).toBe(false);
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0].lineId).toBe('L0');
  });

  it('caps each line at 300 characters after masking', () => {
    const secret = fakeGithubClassic(r);
    const matcher = buildReportMatcher([secret], prefixes);
    const lines = fileWith(secret, 5);
    lines[5] = 'word '.repeat(400) + secret;
    const w = buildWindow(lines, candidate(secret, 5, ''), matcher);
    for (const l of w.lines) expect(l.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
  });

  it('omits an unmaskable line and flags the window', () => {
    const fake: ReportMatcher = {
      maskLine: (l: string) => (l.includes('BAD') ? { unmaskable: true } : { text: l as SafeText }),
      knownValues: () => [],
      keptPrefixes: () => [],
      prime: () => undefined,
    };
    const value = fakeGenericToken(r, 20);
    const lines = ['a', 'b', `v=${value}`, 'BAD line', 'c'];
    const w = buildWindow(lines, candidate(value, 3, ''), fake);
    expect(w.unmaskable).toBe(true);
    expect(w.lines.map((l) => l.lineId)).toEqual(['L-2', 'L-1', 'L0', 'L+2']);
  });
});

describe('mismatch helpers', () => {
  it('finds a value on the line, inside the window, or a multi-line value by its first line', () => {
    const v = fakeGenericToken(r, 24);
    expect(valueOccursInLines(v, [`x ${v} y`])).toBe(true);
    expect(valueOccursInLines(v, ['nothing'])).toBe(false);
    const pem = ['-----BEGIN', ' PRIVATE KEY-----'].join('') + '\n' + fakeGenericToken(r, 64) + '\n' + fakeGenericToken(r, 64);
    expect(valueOccursInLines(pem, ['key:', pem.split('\n')[0]])).toBe(true);
    expect(isContextMismatch(v, ['a', v, 'b'], 1, 0, 2)).toBe(false);
    expect(isContextMismatch(v, ['a', 'b', v], 0, 0, 2)).toBe(false);
    expect(isContextMismatch(v, ['a', 'b'], 5, 0, 1)).toBe(true);
  });
});

describe('context limits', () => {
  it('skips files over 1 MB, splits CRLF, names line ids', () => {
    expect(isContextFileTooLarge(CONTEXT_FILE_MAX_BYTES)).toBe(false);
    expect(isContextFileTooLarge(CONTEXT_FILE_MAX_BYTES + 1)).toBe(true);
    expect(splitFileLines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
    expect([lineIdFor(-2), lineIdFor(0), lineIdFor(3)]).toEqual(['L-2', 'L0', 'L+3']);
  });
});
