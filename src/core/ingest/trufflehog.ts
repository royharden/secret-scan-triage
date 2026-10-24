// trufflehog JSON-lines report parser (one finding object per line). Field names from trufflehog documentation,
// unverified against a real sample until D1 runs. `Verified:true` -> verifiedRaw true; `Verified:false` -> false;
// missing -> undefined. Policy treats false and missing alike (unknown), never as "not real".
import type { RawCandidate } from '../finding.ts';
import { ImportError } from './errors.ts';
import { checkFindingCount, checkTextLength } from './limits.ts';
import { stripBom } from './gitleaks.ts';
import type { ParseResult } from './index.ts';

export const TRUFFLEHOG_FIELDS = [
  'DetectorName',
  'DetectorType',
  'Verified',
  'Raw',
  'RawV2',
  'Redacted',
  'SourceMetadata',
  'ExtraData',
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

/** SourceMetadata.Data.{Filesystem|Git|<other source with a file field>}. */
function sourceOf(rec: Record<string, unknown>): Record<string, unknown> | undefined {
  const sm = rec.SourceMetadata;
  if (!isRecord(sm)) return undefined;
  const data = sm.Data;
  if (!isRecord(data)) return undefined;
  if (isRecord(data.Filesystem)) return data.Filesystem;
  if (isRecord(data.Git)) return data.Git;
  for (const v of Object.values(data)) if (isRecord(v) && typeof v.file === 'string') return v;
  return undefined;
}

export function parseTrufflehog(text: string): ParseResult {
  checkTextLength(text);
  const body = stripBom(text);
  const candidates: RawCandidate[] = [];
  const missingFields: Record<string, number> = {};
  const extraValues: string[] = [];
  const miss = (f: string): void => {
    missingFields[f] = (missingFields[f] ?? 0) + 1;
  };
  let malformed = 0;
  let firstBadLine = -1;
  let records = 0;
  let lineNo = 0;
  let pos = 0;

  while (pos <= body.length) {
    const nl = body.indexOf('\n', pos);
    const end = nl === -1 ? body.length : nl;
    const line = body.slice(pos, end).trim();
    lineNo++;
    pos = end + 1;
    if (line.length === 0) {
      if (nl === -1) break;
      continue;
    }
    records++;
    checkFindingCount(records); // early stop: nothing after record 20,001 is read

    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      rec = undefined; // never keep the engine message: it quotes input
    }
    const raw = isRecord(rec) ? (str(rec.Raw) ?? str(rec.RawV2)) : undefined;
    if (!isRecord(rec) || raw === undefined) {
      malformed++;
      if (firstBadLine < 0) firstBadLine = lineNo;
      if (nl === -1) break;
      continue;
    }

    for (const f of TRUFFLEHOG_FIELDS) {
      const v = rec[f];
      if (v === undefined || v === null || v === '') miss(f);
    }
    const src = sourceOf(rec);
    if (src === undefined) miss('SourceMetadata.Data');
    const path = str(src?.file);
    if (path === undefined) miss('SourceMetadata.Data.file');
    const ln = int(src?.line);
    if (ln === undefined) miss('SourceMetadata.Data.line');

    const ruleId =
      str(rec.DetectorName) ??
      (typeof rec.DetectorType === 'number' && Number.isFinite(rec.DetectorType)
        ? `detector-${rec.DetectorType}`
        : 'unknown');
    const cand: RawCandidate = {
      scanner: 'trufflehog',
      ruleId,
      path: path ?? '',
      line: ln ?? 0,
      rawValue: raw,
      recordIndex: records - 1,
    };
    const commit = str(src?.commit);
    if (commit !== undefined) cand.commit = commit;
    if (rec.Verified === true) cand.verifiedRaw = true;
    else if (rec.Verified === false) cand.verifiedRaw = false;
    // RawV2 can carry additional secret material (e.g. id + secret); it must be masked and guarded too.
    const rawV2 = str(rec.RawV2);
    if (rawV2 !== undefined && rawV2 !== raw) extraValues.push(rawV2);
    candidates.push(cand);
    if (nl === -1) break;
  }

  if (malformed > 0) {
    throw new ImportError('malformed', { location: `line ${firstBadLine}`, count: malformed });
  }
  return { candidates, missingFields, extraValues };
}
