// Ingest entry points (secretnorm). Raw candidates exist only inside the parse worker / Node eval.
import type { RawCandidate } from '../finding.ts';
import { ImportError } from './errors.ts';
import { checkSize, checkTextLength } from './limits.ts';
import { detectFormat } from './detect.ts';
import { parseGitleaks } from './gitleaks.ts';
import { parseTrufflehog } from './trufflehog.ts';

export type ReportFormat = 'gitleaks' | 'trufflehog';

export interface ParseResult {
  candidates: RawCandidate[];
  /** Documented field name -> number of records where it was absent (null/empty counts as absent). */
  missingFields: Record<string, number>;
  /**
   * Additional raw secret material that is not any candidate's rawValue (trufflehog RawV2 when it differs from Raw).
   * Never output; pass to buildReportMatcher / buildLeakGuard together with the candidates' values.
   */
  extraValues: string[];
}

export { ImportError, importErrorMessage } from './errors.ts';
export type { ImportErrorCode, ImportErrorDetails } from './errors.ts';
export { MAX_BYTES, MAX_FINDINGS, checkSize, checkTextLength, checkFindingCount } from './limits.ts';
export { detectFormat, isSarifLike, isTrufflehogRecord } from './detect.ts';
export { parseGitleaks, GITLEAKS_FIELDS } from './gitleaks.ts';
export { parseTrufflehog, TRUFFLEHOG_FIELDS } from './trufflehog.ts';

export function parseReport(text: string, format: ReportFormat): ParseResult {
  checkTextLength(text);
  if (format === 'gitleaks') return parseGitleaks(text);
  if (format === 'trufflehog') return parseTrufflehog(text);
  throw new ImportError('unsupported');
}

/**
 * Convenience for the worker: optional size check (pass File.size), detection unless a format is chosen
 * explicitly, then parse. Throws ImportError ('ambiguous' asks the UI to show the format selector).
 */
export function importReport(
  text: string,
  opts: { format?: ReportFormat; byteLength?: number } = {},
): ParseResult & { format: ReportFormat } {
  if (opts.byteLength !== undefined) checkSize(opts.byteLength);
  checkTextLength(text);
  let format: ReportFormat;
  if (opts.format !== undefined) {
    format = opts.format;
  } else {
    const d = detectFormat(text);
    if (d === 'ambiguous') throw new ImportError('ambiguous');
    if (d === 'unsupported') throw new ImportError('unsupported');
    format = d;
  }
  return { ...parseReport(text, format), format };
}
