import type { Finding } from '../finding.ts';
import type { RulingBinding } from './types.ts';

export type BindingFinding = Pick<Finding, 'id' | 'valueTag' | 'maskedValue' | 'maskedWindow'>;

/** Unambiguous length-safe encoding. No paths, raw values, timestamps or human decisions enter the hash. */
export async function contentHash(finding: Pick<Finding, 'maskedValue' | 'maskedWindow'>): Promise<string> {
  const canonical = JSON.stringify([finding.maskedValue, finding.maskedWindow.map((line) => [line.lineId, line.text])]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function bindFinding(finding: BindingFinding): Promise<RulingBinding> {
  return { findingId: finding.id, contentHash: await contentHash(finding), valueTag: finding.valueTag };
}
export function sameBinding(a: RulingBinding, b: RulingBinding): boolean {
  return a.findingId === b.findingId && a.contentHash === b.contentHash && a.valueTag === b.valueTag;
}
