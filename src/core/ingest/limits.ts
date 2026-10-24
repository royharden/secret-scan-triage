// Import limits (plan §1.1 item 1): 20 MB = 20,000,000 bytes checked on File.size BEFORE reading; 20,000 findings
// counted while parsing with early stop.
import { ImportError } from './errors.ts';

export const MAX_BYTES = 20_000_000;
export const MAX_FINDINGS = 20_000;

/** Call with File.size before reading the file. Throws ImportError('too_large'). */
export function checkSize(byteLength: number): void {
  if (typeof byteLength !== 'number' || !Number.isFinite(byteLength) || byteLength < 0) {
    throw new ImportError('malformed', { location: 'document' });
  }
  if (byteLength > MAX_BYTES) throw new ImportError('too_large', { count: Math.floor(byteLength) });
}

/**
 * Defensive re-check on already-read text. UTF-8 byte length >= UTF-16 length, so a string longer than MAX_BYTES
 * code units is certainly over the byte limit.
 */
export function checkTextLength(text: string): void {
  if (typeof text !== 'string') throw new ImportError('malformed', { location: 'document' });
  if (text.length > MAX_BYTES) throw new ImportError('too_large', { count: text.length });
}

/** Throws ImportError('too_many') as soon as the running count exceeds MAX_FINDINGS. */
export function checkFindingCount(count: number): void {
  if (count > MAX_FINDINGS) throw new ImportError('too_many', { count: MAX_FINDINGS });
}
