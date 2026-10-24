import { describe, expect, it } from 'vitest';
import type { RawCandidate } from '../../src/core/finding.ts';
import { findingId, hmacHex, sanitizeFingerprint, valueTag } from '../../src/core/identity.ts';
import { buildLeakGuard, createSessionSalt } from '../../src/core/mask/leakIndex.ts';
import { NOT_READY_GUARD } from '../../src/core/safe.ts';
import { fakeGithubClassic, rng } from './_helpers.ts';

const r = rng(606);
const HEX64 = /^[0-9a-f]{64}$/;

function cand(rawValue: string, over: Partial<RawCandidate> = {}): RawCandidate {
  return { scanner: 'gitleaks', ruleId: 'github-pat', path: 'src/a.ts', line: 4, rawValue, recordIndex: 0, ...over };
}

describe('hmacHex', () => {
  it('matches RFC 4231 test case 1 (HMAC-SHA-256)', async () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(await hmacHex(key, 'Hi There')).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('refuses a short salt', async () => {
    await expect(hmacHex(new Uint8Array(4), 'x')).rejects.toThrow();
  });
});

describe('findingId', () => {
  it('uses the sanitised fingerprint when supplied', async () => {
    const salt = createSessionSalt();
    expect(await findingId(cand(fakeGithubClassic(r)), salt, 'abc:src/a.ts:github-pat:4')).toBe('abc:src/a.ts:github-pat:4');
  });

  it('falls back to a full 64-hex HMAC that is deterministic and salt/field dependent', async () => {
    const v = fakeGithubClassic(r);
    const s1 = createSessionSalt();
    const s2 = createSessionSalt();
    const a = await findingId(cand(v), s1);
    expect(a).toMatch(HEX64);
    expect(await findingId(cand(v), s1)).toBe(a);
    expect(await findingId(cand(v), s2)).not.toBe(a);
    expect(await findingId(cand(v, { line: 5 }), s1)).not.toBe(a);
    expect(await findingId(cand(v), s1, '')).toBe(a);
    expect(a).not.toContain(v.slice(0, 6));
  });
});

describe('valueTag', () => {
  it('is a 64-hex keyed tag of the value only', async () => {
    const v = fakeGithubClassic(r);
    const salt = createSessionSalt();
    const t = await valueTag(cand(v), salt);
    expect(t).toMatch(HEX64);
    expect(await valueTag(cand(v, { path: 'other.ts', line: 99 }), salt)).toBe(t);
    expect(await valueTag(v, salt)).toBe(t);
    expect(await valueTag(fakeGithubClassic(r), salt)).not.toBe(t);
    expect(t).not.toBe(await findingId(cand(v), salt));
  });
});

describe('sanitizeFingerprint', () => {
  it('keeps a clean fingerprint verbatim and drops one that would leak', () => {
    const v = fakeGithubClassic(r);
    const guard = buildLeakGuard([v], [], createSessionSalt());
    expect(sanitizeFingerprint('c0ffee:src/a.ts:github-pat:4', guard)).toBe('c0ffee:src/a.ts:github-pat:4');
    expect(sanitizeFingerprint(`c0ffee:src/a.ts:${v}:4`, guard)).toBeUndefined();
    expect(sanitizeFingerprint('bad\nfingerprint', guard)).toBeUndefined();
    expect(sanitizeFingerprint(undefined, guard)).toBeUndefined();
    expect(sanitizeFingerprint('c0ffee:a:b:1', NOT_READY_GUARD)).toBeUndefined();
  });
});
