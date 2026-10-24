// Masked context window builder (pure; folder wiring comes in M3). Runs in the worker on raw file lines; returns
// only masked lines. Up to ±3 lines (hard max 7 total), 300 chars per line, files over 1 MB skipped by the caller.
import type { MaskedLine, RawCandidate } from '../finding.ts';
import type { ReportMatcher } from '../mask/reportMatcher.ts';
import { isContextMismatch } from './mismatch.ts';

export const DEFAULT_RADIUS = 3;
export const MAX_RADIUS = 3;
export const MAX_WINDOW_LINES = 7;
export const MAX_LINE_CHARS = 300;
/** Raw lines are cut to this before masking (masking the head of a very long line, then cutting to 300, is safe). */
export const PRE_MASK_LINE_CHARS = 1_000;
export const CONTEXT_FILE_MAX_BYTES = 1_000_000;

/** Files over 1 MB are skipped for context (match line only). */
export function isContextFileTooLarge(byteLength: number): boolean {
  return !Number.isFinite(byteLength) || byteLength > CONTEXT_FILE_MAX_BYTES;
}

export function splitFileLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 'L0' = match line, 'L-1', 'L+2', ... */
export function lineIdFor(offset: number): string {
  if (offset === 0) return 'L0';
  return offset > 0 ? `L+${offset}` : `L${offset}`;
}

function clampRadius(r: number | undefined): number {
  if (r === undefined || !Number.isFinite(r)) return DEFAULT_RADIUS;
  return Math.max(0, Math.min(MAX_RADIUS, Math.floor(r)));
}

/** Mask one display line: pre-cut, mask, cut to MAX_LINE_CHARS, re-mask the cut text (keeps the guard invariant). */
function maskDisplayLine(raw: string, matcher: ReportMatcher): MaskedLine['text'] | null {
  const first = matcher.maskLine(raw.length > PRE_MASK_LINE_CHARS ? raw.slice(0, PRE_MASK_LINE_CHARS) : raw);
  if (!('text' in first)) return null;
  if (first.text.length <= MAX_LINE_CHARS) return first.text;
  const second = matcher.maskLine(first.text.slice(0, MAX_LINE_CHARS));
  return 'text' in second ? second.text : null;
}

export function buildWindow(
  fileLines: string[] | null,
  raw: RawCandidate,
  matcher: ReportMatcher,
  radius?: number,
): { lines: MaskedLine[]; mismatch: boolean; unmaskable: boolean } {
  const r = clampRadius(radius);
  const lines: MaskedLine[] = [];
  let unmaskable = false;
  let mismatch = false;

  const push = (offset: number, text: string): void => {
    const masked = maskDisplayLine(text, matcher);
    if (masked === null) {
      unmaskable = true; // omitted; caller routes the finding to review
      return;
    }
    lines.push({ lineId: lineIdFor(offset), text: masked });
  };

  if (fileLines !== null) {
    const idx = raw.line - 1;
    const start = Math.max(0, idx - r);
    const end = Math.min(fileLines.length - 1, idx + r);
    if (!isContextMismatch(raw.rawValue, fileLines, idx, start, end)) {
      for (let i = start; i <= end && lines.length < MAX_WINDOW_LINES; i++) push(i - idx, fileLines[i]);
      return { lines, mismatch: false, unmaskable };
    }
    mismatch = true;
  }

  // Default / fallback: the match line as reported.
  if (typeof raw.rawLine === 'string' && raw.rawLine.length > 0) push(0, raw.rawLine);
  return { lines, mismatch, unmaskable };
}
