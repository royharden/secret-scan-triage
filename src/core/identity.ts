// Finding identity (PLAN P6): full HMAC-SHA256 hex (64 chars) via Web Crypto (browser, worker, Node 24).
// projectSalt is the persisted, client-only identity salt — distinct from the session-only leak-guard salt (P5).
import type { RawCandidate } from './finding.ts';
import { LeakGuardError } from './safe.ts';
import type { LeakGuard } from './safe.ts';

const MIN_SALT_BYTES = 16;
const encoder = new TextEncoder();
const keyCache = new WeakMap<Uint8Array, Promise<CryptoKey>>();

function subtleCrypto(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto (crypto.subtle) is unavailable.');
  return s;
}

function hmacKey(salt: Uint8Array): Promise<CryptoKey> {
  let p = keyCache.get(salt);
  if (p === undefined) {
    // Copy so the key material is an ArrayBuffer-backed view (and later mutation of `salt` cannot desync the cache).
    const bytes = new Uint8Array(salt);
    p = subtleCrypto().importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(salt, p);
  }
  return p;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Full HMAC-SHA256(salt, message) as 64 lowercase hex characters. */
export async function hmacHex(salt: Uint8Array, message: string): Promise<string> {
  if (!(salt instanceof Uint8Array) || salt.length < MIN_SALT_BYTES) {
    throw new Error(`HMAC salt must be at least ${MIN_SALT_BYTES} bytes.`);
  }
  const key = await hmacKey(salt);
  const sig = await subtleCrypto().sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/**
 * Finding id: the sanitised scanner fingerprint when one is supplied (see sanitizeFingerprint), else
 * HMAC-SHA256(projectSalt, ruleId|path|line|rawValue) hex.
 */
export async function findingId(raw: RawCandidate, salt: Uint8Array, sanitizedFingerprint?: string): Promise<string> {
  if (typeof sanitizedFingerprint === 'string' && sanitizedFingerprint.length > 0) return sanitizedFingerprint;
  return hmacHex(salt, `${raw.ruleId}|${raw.path}|${raw.line}|${raw.rawValue}`);
}

/** Private keyed change tag: HMAC-SHA256(projectSalt, "value|" + rawValue) hex. Accepts a candidate or a raw value. */
export async function valueTag(raw: RawCandidate | string, salt: Uint8Array): Promise<string> {
  const value = typeof raw === 'string' ? raw : raw.rawValue;
  return hmacHex(salt, `value|${value}`);
}

const MAX_FINGERPRINT_CHARS = 512;

/**
 * Keep a scanner fingerprint only if it is plain printable text and passes the leak guard; otherwise drop it (the
 * caller then falls back to the HMAC id). Non-guard errors propagate.
 */
export function sanitizeFingerprint(fp: string | undefined, guard: LeakGuard): string | undefined {
  if (typeof fp !== 'string') return undefined;
  const s = fp; // kept verbatim (.gitleaksignore needs the exact fingerprint)
  if (s.trim().length === 0 || s.length > MAX_FINGERPRINT_CHARS) return undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return undefined;
  }
  try {
    guard.check(s, 'export');
  } catch (e) {
    if (e instanceof LeakGuardError) return undefined;
    throw e;
  }
  return s;
}
