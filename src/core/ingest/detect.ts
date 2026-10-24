// Report format auto-detection. First non-space byte '[' -> gitleaks; leading lines that parse as objects with
// DetectorName -> trufflehog; SARIF ($schema / runs) and anything else -> unsupported; mixed evidence -> ambiguous
// (the UI then shows the explicit format selector).
import type { ReportFormat } from './index.ts';
import { MAX_BYTES } from './limits.ts';

const SAMPLE_LINES = 20;
const SAMPLE_CHARS = 1_000_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isSarifLike(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (typeof v.$schema === 'string' && /sarif/i.test(v.$schema)) return true;
  return Array.isArray(v.runs);
}

export function isTrufflehogRecord(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return typeof v.DetectorName === 'string' || (isRecord(v.SourceMetadata) && 'DetectorType' in v);
}

function firstNonSpace(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // space, tab, CR, LF, BOM
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 0xfeff) return i;
  }
  return -1;
}

export function detectFormat(text: string): ReportFormat | 'ambiguous' | 'unsupported' {
  if (typeof text !== 'string') return 'unsupported';
  const i = firstNonSpace(text);
  if (i < 0) return 'unsupported';
  const c = text[i];
  if (c === '[') return 'gitleaks';
  if (c !== '{') return 'unsupported';

  let truffle = 0;
  let other = 0;
  let unparsable = 0;
  let seen = 0;
  let pos = i;
  while (pos < text.length && seen < SAMPLE_LINES && pos - i < SAMPLE_CHARS) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    if (line.length > 0) {
      seen++;
      let obj: unknown;
      let ok = true;
      try {
        obj = JSON.parse(line);
      } catch {
        ok = false;
      }
      if (!ok) unparsable++;
      else if (isSarifLike(obj)) return 'unsupported';
      else if (isTrufflehogRecord(obj)) truffle++;
      else other++;
    }
    if (nl === -1) break;
  }

  if (truffle > 0 && other === 0 && unparsable === 0) return 'trufflehog';
  if (truffle > 0) return 'ambiguous';
  if (other > 0) return 'unsupported';

  // No line parsed on its own: maybe one pretty-printed JSON document (SARIF usually is).
  if (text.length <= MAX_BYTES) {
    try {
      const whole: unknown = JSON.parse(text.slice(i));
      if (isSarifLike(whole)) return 'unsupported';
      if (isTrufflehogRecord(whole)) return 'ambiguous';
    } catch {
      // fall through
    }
  }
  return 'unsupported';
}
