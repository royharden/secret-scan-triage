import { describe, expect, it } from 'vitest';
import {
  ImportError,
  MAX_BYTES,
  MAX_FINDINGS,
  checkSize,
  detectFormat,
  importReport,
  parseReport,
} from '../../src/core/ingest/index.ts';
import { HEX, containsRawMaterial, fakeAwsKeyId, fakeGenericToken, fakeGithubClassic, randomChars, rng } from './_helpers.ts';

const r = rng(101);

function gitleaksRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  const secret = fakeGithubClassic(r);
  const commit = randomChars(r, 40, HEX);
  return {
    RuleID: 'github-pat',
    Description: 'GitHub Personal Access Token',
    StartLine: 12,
    EndLine: 12,
    StartColumn: 9,
    EndColumn: 49,
    Match: `token = "${secret}"`,
    Secret: secret,
    File: 'src/app.ts',
    SymlinkFile: 'link/app.ts',
    Commit: commit,
    Entropy: 4.2,
    Author: 'dev',
    Email: 'dev@example.invalid',
    Date: '2026-01-01T00:00:00Z',
    Message: 'commit message',
    Tags: ['t'],
    Fingerprint: `${commit}:src/app.ts:github-pat:12`,
    ...over,
  };
}

function truffleRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = fakeAwsKeyId(r);
  return {
    SourceMetadata: { Data: { Filesystem: { file: 'config/aws.env', line: 3 } } },
    SourceID: 1,
    SourceType: 15,
    SourceName: 'trufflehog - filesystem',
    DetectorType: 2,
    DetectorName: 'AWS',
    DecoderName: 'PLAIN',
    Verified: false,
    Raw: raw,
    Redacted: raw.slice(0, 4),
    ExtraData: { account: 'n/a' },
    ...over,
  };
}

function ndjson(recs: unknown[]): string {
  return recs.map((x) => JSON.stringify(x)).join('\n') + '\n';
}

function catchImport(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError);
    return e as ImportError;
  }
  throw new Error('expected ImportError');
}

describe('gitleaks parser', () => {
  it('maps documented fields onto a raw candidate', () => {
    const rec = gitleaksRecord();
    const res = parseReport(JSON.stringify([rec]), 'gitleaks');
    expect(res.candidates).toHaveLength(1);
    const c = res.candidates[0];
    expect(c.scanner).toBe('gitleaks');
    expect(c.ruleId).toBe('github-pat');
    expect(c.path).toBe('src/app.ts');
    expect(c.line).toBe(12);
    expect(c.rawValue).toBe(rec.Secret);
    expect(c.rawLine).toBe(rec.Match);
    expect(c.commit).toBe(rec.Commit);
    expect(c.fingerprint).toBe(rec.Fingerprint);
    expect(c.scannerEntropy).toBe(4.2);
    expect(c.recordIndex).toBe(0);
    expect(c.verifiedRaw).toBeUndefined();
    expect(res.missingFields).toEqual({});
  });

  it('tolerates missing optional fields and counts each absence', () => {
    const secret = fakeGenericToken(r);
    const res = parseReport(JSON.stringify([{ Secret: secret, File: 'a.txt' }, { Secret: secret }]), 'gitleaks');
    expect(res.candidates).toHaveLength(2);
    const [a, b] = res.candidates;
    expect(a.ruleId).toBe('unknown');
    expect(a.line).toBe(0);
    expect(a.fingerprint).toBeUndefined();
    expect(a.commit).toBeUndefined();
    expect(a.scannerEntropy).toBeUndefined();
    expect(b.path).toBe('');
    expect(res.missingFields.RuleID).toBe(2);
    expect(res.missingFields.Fingerprint).toBe(2);
    expect(res.missingFields.Commit).toBe(2);
    expect(res.missingFields.File).toBe(1);
    expect(res.missingFields.Secret).toBeUndefined();
  });

  it('falls back to Match when Secret is absent, and prefers a Line field as the raw line', () => {
    const rec = gitleaksRecord();
    const noSecret = { ...rec, Secret: undefined };
    const withLine = { ...rec, Line: `    const ${String(rec.Match)}; // ctx` };
    const res = parseReport(JSON.stringify([noSecret, withLine]), 'gitleaks');
    expect(res.candidates[0].rawValue).toBe(rec.Match);
    expect(res.candidates[1].rawLine).toBe(withLine.Line);
  });

  it('ignores a non-finite scanner entropy (display only, never evidence)', () => {
    const res = parseReport(JSON.stringify([gitleaksRecord({ Entropy: 'high' })]), 'gitleaks');
    expect(res.candidates[0].scannerEntropy).toBeUndefined();
  });
});

describe('trufflehog parser', () => {
  it('reads Filesystem source metadata and maps Verified:true to verifiedRaw', () => {
    const rec = truffleRecord({ Verified: true });
    const res = parseReport(ndjson([rec]), 'trufflehog');
    const c = res.candidates[0];
    expect(c.scanner).toBe('trufflehog');
    expect(c.ruleId).toBe('AWS');
    expect(c.path).toBe('config/aws.env');
    expect(c.line).toBe(3);
    expect(c.rawValue).toBe(rec.Raw);
    expect(c.verifiedRaw).toBe(true);
    expect(c.fingerprint).toBeUndefined();
  });

  it('reads Git source metadata; Verified:false -> false, missing -> undefined (both unknown to policy)', () => {
    const commit = randomChars(r, 40, HEX);
    const git = { SourceMetadata: { Data: { Git: { commit, file: 'lib/x.py', line: 7, email: 'e@example.invalid' } } } };
    const a = truffleRecord({ ...git, Verified: false });
    const b = truffleRecord(git);
    delete b.Verified;
    const res = parseReport(ndjson([a, b]), 'trufflehog');
    expect(res.candidates[0].commit).toBe(commit);
    expect(res.candidates[0].path).toBe('lib/x.py');
    expect(res.candidates[0].line).toBe(7);
    expect(res.candidates[0].verifiedRaw).toBe(false);
    expect(res.candidates[1].verifiedRaw).toBeUndefined();
    expect(res.missingFields.Verified).toBe(1);
  });

  it('reports RawV2 secret material as an extra value to mask', () => {
    const raw = fakeAwsKeyId(r);
    const rawV2 = raw + fakeGenericToken(r, 40);
    const res = parseReport(ndjson([truffleRecord({ Raw: raw, RawV2: rawV2 })]), 'trufflehog');
    expect(res.candidates[0].rawValue).toBe(raw);
    expect(res.extraValues).toEqual([rawV2]);
  });

  it('derives a rule id from DetectorType when DetectorName is absent, and counts missing location fields', () => {
    const rec = truffleRecord({ SourceMetadata: { Data: {} } });
    delete rec.DetectorName;
    const res = parseReport(ndjson([rec]), 'trufflehog');
    expect(res.candidates[0].ruleId).toBe('detector-2');
    expect(res.candidates[0].path).toBe('');
    expect(res.candidates[0].line).toBe(0);
    expect(res.missingFields.DetectorName).toBe(1);
    expect(res.missingFields['SourceMetadata.Data']).toBe(1);
    expect(res.missingFields['SourceMetadata.Data.file']).toBe(1);
  });

  it('skips blank lines and accepts CRLF', () => {
    const text = '\r\n' + JSON.stringify(truffleRecord()) + '\r\n\r\n' + JSON.stringify(truffleRecord()) + '\r\n';
    const res = parseReport(text, 'trufflehog');
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates[1].recordIndex).toBe(1);
  });
});

describe('detectFormat', () => {
  it('first non-space "[" -> gitleaks (BOM and whitespace tolerated)', () => {
    expect(detectFormat('[]')).toBe('gitleaks');
    expect(detectFormat('﻿ \n\t[ {"RuleID":"x"} ]')).toBe('gitleaks');
  });

  it('JSON lines with DetectorName -> trufflehog', () => {
    expect(detectFormat(ndjson([truffleRecord(), truffleRecord()]))).toBe('trufflehog');
  });

  it('SARIF (single line or pretty-printed) -> unsupported', () => {
    const sarif = { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [] };
    expect(detectFormat(JSON.stringify(sarif))).toBe('unsupported');
    expect(detectFormat(JSON.stringify(sarif, null, 2))).toBe('unsupported');
    expect(detectFormat(JSON.stringify({ runs: [{ results: [] }] }))).toBe('unsupported');
  });

  it('mixed evidence -> ambiguous; unknown objects, text and empty input -> unsupported', () => {
    expect(detectFormat(ndjson([truffleRecord(), { hello: 'world' }]))).toBe('ambiguous');
    expect(detectFormat(ndjson([{ hello: 'world' }]))).toBe('unsupported');
    expect(detectFormat('plain text report')).toBe('unsupported');
    expect(detectFormat('   \n ')).toBe('unsupported');
    expect(detectFormat(JSON.stringify(truffleRecord(), null, 2))).toBe('ambiguous');
  });
});

describe('importReport', () => {
  it('rejects SARIF as unsupported', () => {
    const e = catchImport(() => importReport(JSON.stringify({ version: '2.1.0', runs: [] })));
    expect(e.code).toBe('unsupported');
  });

  it('ambiguous input asks for an explicit format; the override then parses', () => {
    const text = ndjson([truffleRecord(), { hello: 'world' }]);
    expect(catchImport(() => importReport(text)).code).toBe('ambiguous');
    const onlyTruffle = ndjson([truffleRecord()]);
    const res = importReport(onlyTruffle, { format: 'trufflehog' });
    expect(res.format).toBe('trufflehog');
    expect(res.candidates).toHaveLength(1);
  });

  it('checks the byte size before parsing', () => {
    const e = catchImport(() => importReport('[]', { byteLength: MAX_BYTES + 1 }));
    expect(e.code).toBe('too_large');
  });
});

describe('limits', () => {
  it('checkSize: 20,000,000 bytes accepted, one more rejected, invalid sizes rejected', () => {
    expect(() => checkSize(MAX_BYTES)).not.toThrow();
    expect(catchImport(() => checkSize(MAX_BYTES + 1)).code).toBe('too_large');
    expect(catchImport(() => checkSize(Number.NaN)).code).toBe('malformed');
    expect(MAX_BYTES).toBe(20_000_000);
    expect(MAX_FINDINGS).toBe(20_000);
  });

  it('rejects already-read text longer than the byte limit (generated, not committed)', () => {
    const oversize = ' '.repeat(MAX_BYTES) + '[]';
    expect(catchImport(() => parseReport(oversize, 'gitleaks')).code).toBe('too_large');
  });

  it('accepts exactly 20,000 gitleaks findings and rejects 20,001', () => {
    const rec = '{"Secret":"v","File":"f"}';
    const ok = '[' + new Array(MAX_FINDINGS).fill(rec).join(',') + ']';
    expect(parseReport(ok, 'gitleaks').candidates).toHaveLength(MAX_FINDINGS);
    const tooMany = '[' + new Array(MAX_FINDINGS + 1).fill(rec).join(',') + ']';
    const e = catchImport(() => parseReport(tooMany, 'gitleaks'));
    expect(e.code).toBe('too_many');
  });

  it('trufflehog stops early: a malformed line after record 20,001 is never reached', () => {
    const line = JSON.stringify({ DetectorName: 'X', Raw: 'v' });
    const text = new Array(MAX_FINDINGS + 1).fill(line).join('\n') + '\n{not json\n';
    expect(catchImport(() => parseReport(text, 'trufflehog')).code).toBe('too_many');
  });
});

describe('import errors never echo report text', () => {
  it('invalid gitleaks JSON: masked message, document location', () => {
    const secret = fakeGithubClassic(r);
    const e = catchImport(() => parseReport(`[{"Secret": "${secret}", oops}]`, 'gitleaks'));
    expect(e.code).toBe('malformed');
    expect(e.location).toBe('document');
    expect(containsRawMaterial(e.message, secret)).toBe(false);
    expect(e.message).not.toContain('oops');
  });

  it('broken trufflehog line: location and count only', () => {
    const secret = fakeGenericToken(r);
    const text = JSON.stringify(truffleRecord()) + '\n' + `{"Raw":"${secret}",` + '\n' + `{"Raw":"${secret}"`;
    const e = catchImport(() => parseReport(text, 'trufflehog'));
    expect(e.code).toBe('malformed');
    expect(e.location).toBe('line 2');
    expect(e.count).toBe(2);
    expect(containsRawMaterial(e.message, secret)).toBe(false);
  });

  it('gitleaks records without a value or not objects: counted, first location reported', () => {
    const e = catchImport(() =>
      parseReport(JSON.stringify([gitleaksRecord(), { RuleID: 'x' }, 'str', gitleaksRecord()]), 'gitleaks'),
    );
    expect(e.code).toBe('malformed');
    expect(e.location).toBe('record 2');
    expect(e.count).toBe(2);
  });

  it('ImportError drops a location that is not structural', () => {
    const secret = fakeGithubClassic(r);
    const e = new ImportError('malformed', { location: secret, count: 1 });
    expect(e.location).toBeUndefined();
    expect(containsRawMaterial(e.message, secret)).toBe(false);
  });
});
