// Import errors. Messages are built ONLY from the error code, a structural location ("record N", "line N",
// "document") and counts — never from report text or engine error messages (JSON.parse errors quote input).

export type ImportErrorCode = 'too_large' | 'too_many' | 'unsupported' | 'ambiguous' | 'malformed';

export interface ImportErrorDetails {
  location?: string;
  count?: number;
}

const SAFE_LOCATION = /^(?:record \d{1,9}|line \d{1,9}|document)$/;

function safeLocation(loc: unknown): string | undefined {
  return typeof loc === 'string' && SAFE_LOCATION.test(loc) ? loc : undefined;
}

function safeCount(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function fmt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function importErrorMessage(code: ImportErrorCode, details: ImportErrorDetails = {}): string {
  const location = safeLocation(details.location);
  const count = safeCount(details.count);
  switch (code) {
    case 'too_large':
      return `Report is larger than the 20,000,000-byte limit${count !== undefined ? ` (${fmt(count)} bytes)` : ''}.`;
    case 'too_many':
      return 'Report has more than 20,000 findings; import stopped.';
    case 'unsupported':
      return 'Unsupported report format. Supported: gitleaks JSON (array) and trufflehog JSON lines. SARIF is not supported.';
    case 'ambiguous':
      return 'Could not tell the report format. Choose gitleaks or trufflehog explicitly.';
    case 'malformed': {
      if (location === 'document') return 'Malformed report: the document is not valid JSON of the expected shape.';
      const what = count !== undefined ? `${fmt(count)} malformed record${count === 1 ? '' : 's'}` : 'malformed input';
      return `Malformed report: ${what}${location !== undefined ? `; first at ${location}` : ''}.`;
    }
    default:
      return 'Import failed.';
  }
}

export class ImportError extends Error {
  code: ImportErrorCode;
  location?: string;
  count?: number;

  constructor(code: ImportErrorCode, details: ImportErrorDetails = {}) {
    super(importErrorMessage(code, details));
    this.name = 'ImportError';
    this.code = code;
    this.location = safeLocation(details.location);
    this.count = safeCount(details.count);
  }
}
