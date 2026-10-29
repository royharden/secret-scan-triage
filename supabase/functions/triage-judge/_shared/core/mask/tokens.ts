// Generic credential-looking token detector, used to mask (and guard) secrets the scanner did NOT report.
// Heuristic by design (plan §1.1 item 3): length >= 16 with computed entropy above the class threshold, or a
// known-prefix provider pattern. Paths, identifiers and single-case words are not tokens.
import { classifyChars } from '../features/charclass.ts';
import { shannonEntropy } from '../features/entropy.ts';
import { entropyThreshold } from '../features/buckets.ts';
import { isIdentifierShape, isPathLike } from '../features/shapes.ts';

export const MIN_TOKEN_LENGTH = 16;

export interface TokenSpan {
  start: number;
  end: number;
  value: string;
}

// Known provider shapes. These are patterns, not tokens; they match regardless of entropy.
const KNOWN_PREFIX_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

// Candidate runs: base64/base64url alphabet, optional '=' padding. '.', ':', quotes and whitespace split runs.
const RUN = /[A-Za-z0-9+/_-]+={0,2}/g;

/** Does a single run look like a credential? (Entropy computed here.) */
export function isCredentialLikeToken(s: string): boolean {
  if (typeof s !== 'string') return false;
  const core = s.replace(/=+$/, '');
  if (core.length < MIN_TOKEN_LENGTH) return false;
  if (isPathLike(core) || isIdentifierShape(core)) return false;
  const cls = classifyChars(core);
  if (cls === 'digits') return false;
  const lower = /[a-z]/.test(core);
  const upper = /[A-Z]/.test(core);
  const digit = /[0-9]/.test(core);
  if (cls === 'hex') {
    if (!digit || !(lower || upper)) return false;
  } else if ((lower ? 1 : 0) + (upper ? 1 : 0) + (digit ? 1 : 0) < 2) {
    return false;
  }
  return shannonEntropy(core) >= entropyThreshold(cls, core.length);
}

function mergeSpans(text: string, spans: Array<{ start: number; end: number }>): TokenSpan[] {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: TokenSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && s.start <= last.end) {
      if (s.end > last.end) {
        last.end = s.end;
        last.value = text.slice(last.start, last.end);
      }
      continue;
    }
    out.push({ start: s.start, end: s.end, value: text.slice(s.start, s.end) });
  }
  return out;
}

/** Credential-looking tokens in `text`, as sorted, non-overlapping spans. */
export function findCredentialTokens(text: string): Array<{ start: number; end: number; value: string }> {
  if (typeof text !== 'string' || text.length < MIN_TOKEN_LENGTH) return [];
  const spans: Array<{ start: number; end: number }> = [];
  for (const re of KNOWN_PREFIX_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      spans.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  RUN.lastIndex = 0;
  for (let m = RUN.exec(text); m !== null; m = RUN.exec(text)) {
    if (m[0].length >= MIN_TOKEN_LENGTH && isCredentialLikeToken(m[0])) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return mergeSpans(text, spans);
}
