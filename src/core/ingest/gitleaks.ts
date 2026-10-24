// gitleaks JSON report parser (array of findings). Field names from gitleaks documentation, unverified against a
// real sample until D1 runs (docs/report-formats.md). Optional fields are tolerated; absent ones are counted.
import type { RawCandidate } from '../finding.ts';
import { ImportError } from './errors.ts';
import { checkFindingCount, checkTextLength } from './limits.ts';
import type { ParseResult } from './index.ts';

export const GITLEAKS_FIELDS = [
  'RuleID',
  'Description',
  'StartLine',
  'EndLine',
  'StartColumn',
  'EndColumn',
  'Match',
  'Secret',
  'File',
  'SymlinkFile',
  'Commit',
  'Entropy',
  'Author',
  'Email',
  'Date',
  'Message',
  'Tags',
  'Fingerprint',
] as const;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseGitleaks(text: string): ParseResult {
  checkTextLength(text);
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    throw new ImportError('malformed', { location: 'document' }); // never echo the engine message
  }
  if (!Array.isArray(data)) throw new ImportError('malformed', { location: 'document' });
  // Early stop: refuse before building any candidate.
  checkFindingCount(data.length);

  const candidates: RawCandidate[] = [];
  const missingFields: Record<string, number> = {};
  const miss = (f: string): void => {
    missingFields[f] = (missingFields[f] ?? 0) + 1;
  };
  let malformed = 0;
  let firstBad = -1;

  for (let i = 0; i < data.length; i++) {
    const rec: unknown = data[i];
    if (!isRecord(rec)) {
      malformed++;
      if (firstBad < 0) firstBad = i;
      continue;
    }
    const secret = str(rec.Secret);
    const match = str(rec.Match);
    const rawValue = secret ?? match;
    if (rawValue === undefined) {
      malformed++;
      if (firstBad < 0) firstBad = i;
      continue;
    }
    for (const f of GITLEAKS_FIELDS) {
      const v = rec[f];
      if (v === undefined || v === null || v === '') miss(f);
    }
    const ruleId = str(rec.RuleID) ?? 'unknown';
    const path = str(rec.File) ?? str(rec.SymlinkFile) ?? '';
    const line = int(rec.StartLine) ?? 0;
    const cand: RawCandidate = { scanner: 'gitleaks', ruleId, path, line, rawValue, recordIndex: i };
    const commit = str(rec.Commit);
    if (commit !== undefined) cand.commit = commit;
    const fingerprint = str(rec.Fingerprint);
    if (fingerprint !== undefined) cand.fingerprint = fingerprint;
    // Newer gitleaks versions include the full source line as `Line`; else the match is the best line context.
    const rawLine = str(rec.Line) ?? match;
    if (rawLine !== undefined) cand.rawLine = rawLine;
    if (typeof rec.Entropy === 'number' && Number.isFinite(rec.Entropy)) cand.scannerEntropy = rec.Entropy;
    candidates.push(cand);
  }

  if (malformed > 0) {
    throw new ImportError('malformed', { location: `record ${firstBad + 1}`, count: malformed });
  }
  // `Match` (the rule's full match, e.g. keyword + secret) is not indexed as a value: it is masked as a line by the
  // report matcher (secret n-grams + detected tokens). gitleaks reports carry no extra secret fields.
  return { candidates, missingFields, extraValues: [] };
}
