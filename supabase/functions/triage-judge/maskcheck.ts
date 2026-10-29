// Defence in depth, not proof of absence. Uses the exact client generic token detector from the closed staged core.
import { findCredentialTokens } from './_shared/core/mask/tokens.ts';
import { LeakGuardError } from './_shared/core/safe.ts';
import type { Boundary, LeakGuard } from './_shared/core/safe.ts';
import type { MaskedView } from './_shared/core/judge/contract.ts';
import { MAX_VIEW_BYTES } from './_shared/core/judge/contract.ts';
const PATHS = ['test', 'fixture', 'docs', 'lockfile', 'source', 'config', 'other'];
const CLASSES = ['hex', 'base64', 'base64url', 'alnum', 'digits', 'mixed', 'pem'];
const KEYS = ['findingId', 'ruleId', 'pathClass', 'basename', 'maskedLine', 'maskedWindow', 'lengthBucket', 'entropyBucket', 'charClass', 'signalBuckets', 'scannerVerified'];
function object(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function text(x: unknown, max = 4096): x is string { return typeof x === 'string' && x.length <= max && !x.includes('\u0000'); }
function exactKeys(x: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(x).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(x, key));
}
export function credentialLikeStrings(x: unknown): boolean {
  if (typeof x === 'string') return findCredentialTokens(x).length > 0;
  if (Array.isArray(x)) return x.some(credentialLikeStrings);
  if (object(x)) return Object.entries(x).some(([k, value]) => credentialLikeStrings(k) || credentialLikeStrings(value));
  return false;
}
export function validateMaskedView(raw: unknown): raw is MaskedView {
  if (!object(raw) || !exactKeys(raw, KEYS) ||
      !text(raw.findingId, 100) || !/^candidate-[0-9]{1,5}$/.test(raw.findingId) ||
      !text(raw.ruleId, 160) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(raw.ruleId) || !PATHS.includes(raw.pathClass as string) ||
      !text(raw.basename, 255) || /[\\/]/.test(raw.basename) || !text(raw.maskedLine) ||
      !['xs', 's', 'm', 'l', 'xl'].includes(raw.lengthBucket as string) ||
      !['low', 'mid', 'high'].includes(raw.entropyBucket as string) || !CLASSES.includes(raw.charClass as string) ||
      typeof raw.scannerVerified !== 'boolean' || !Array.isArray(raw.maskedWindow) || raw.maskedWindow.length > 7 ||
      !Array.isArray(raw.signalBuckets) || raw.signalBuckets.length > 16) return false;
  const lineIds = new Set<string>();
  for (const line of raw.maskedWindow) {
    if (!object(line) || !exactKeys(line, ['lineId', 'text']) || !text(line.lineId, 3) ||
        !/^L(?:0|[+-][1-3])$/.test(line.lineId) || !text(line.text) || lineIds.has(line.lineId)) return false;
    if (line.lineId === 'L0' && line.text !== raw.maskedLine) return false;
    lineIds.add(line.lineId);
  }
  if (raw.maskedWindow.length > 0 && !lineIds.has('L0')) return false;
  if (!raw.signalBuckets.every((s: unknown) => text(s, 40) && /^S-(?:R[1-5]|F(?:[1-9]|1[01])):(?:real|fp):(?:decisive|strong|weak)$/.test(s))) return false;
  return new TextEncoder().encode(JSON.stringify(raw)).byteLength <= MAX_VIEW_BYTES && !credentialLikeStrings(raw);
}
/** Server has no browser leak index; generic scanning is an independent additional check, explicitly weaker. */
export const SERVER_MASK_GUARD: LeakGuard = Object.freeze({
  ready: true,
  check(value: string, boundary: Boundary) { if (findCredentialTokens(value).length > 0) throw new LeakGuardError(boundary); },
  exemptDigests: () => 0,
});
/** Only exact server-issued accounting identifiers may be allowed on the open-budget response boundary.
 * Never populate this set from a request or model output. No such exemption is used for provider requests/views. */
export function accountingResponseGuard(issuedIds: ReadonlySet<string>): LeakGuard {
  return { ready: true, exemptDigests: () => 0, check(value: string, boundary: Boundary) {
    if (findCredentialTokens(value).some((token) => !issuedIds.has(token.value))) throw new LeakGuardError(boundary);
  } };
}
