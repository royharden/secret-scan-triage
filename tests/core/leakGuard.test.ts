import { describe, expect, it } from 'vitest';
import prefixConfig from '../../config/prefixes.json';
import { BOUNDARIES, LeakGuardError, NOT_READY_GUARD, serializeSafe } from '../../src/core/safe.ts';
import { buildLeakGuard, buildLeakIndex, createSessionSalt, SESSION_SALT_BYTES } from '../../src/core/mask/leakIndex.ts';
import type { KeptPrefix, LeakIndex } from '../../src/core/mask/leakIndex.ts';
import { guardedSafeText } from '../../src/core/mask/leakGuard.ts';
import type { IndexedLeakGuard } from '../../src/core/mask/leakGuard.ts';
import { hmacHex } from '../../src/core/identity.ts';
import { loadPrefixConfig, maskValue, prefixStrings } from '../../src/core/mask/mask.ts';
import {
  HEX,
  containsRawMaterial,
  fakeAwsKeyId,
  fakeGenericToken,
  fakeGithubClassic,
  fakeGithubFineGrained,
  mixedBody,
  randomChars,
  rng,
  walk,
} from './_helpers.ts';

const r = rng(303);
const prefixes = prefixStrings(loadPrefixConfig(prefixConfig));

function keptFor(values: string[]): KeptPrefix[] {
  const out: KeptPrefix[] = [];
  for (const v of values) {
    const k = maskValue(v, prefixes).keptPrefix;
    if (k !== undefined) out.push({ value: v, prefix: k });
  }
  return out;
}

function guardFor(values: string[]): IndexedLeakGuard {
  return buildLeakGuard(values, keptFor(values), createSessionSalt()) as IndexedLeakGuard;
}

function catchGuard(fn: () => unknown): LeakGuardError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LeakGuardError);
    return e as LeakGuardError;
  }
  throw new Error('expected LeakGuardError');
}

describe('session salt', () => {
  it('is random, 32 bytes, and two sessions differ', () => {
    const a = createSessionSalt();
    const b = createSessionSalt();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(SESSION_SALT_BYTES);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('refuses a short salt', () => {
    expect(() => buildLeakGuard(['abcdefgh'], [], new Uint8Array(4))).toThrow();
  });
});

describe('serializeSafe + leak guard', () => {
  it('throws on an injected leak through every boundary, with a masked message', () => {
    const gh = fakeGithubClassic(r);
    const guard = guardFor([gh]);
    for (const b of BOUNDARIES) {
      const e = catchGuard(() => serializeSafe({ ok: 'fine', note: `see ${gh}` }, b, guard));
      expect(e.boundary).toBe(b);
      expect(e.reason).toBe('leak');
      expect(containsRawMaterial(e.message, gh)).toBe(false);
    }
  });

  it('catches any 6-character substring, nested keys, and values hidden by JSON escaping', () => {
    const v = mixedBody(r, 20) + '"\\' + mixedBody(r, 20);
    const guard = guardFor([v]);
    expect(() => serializeSafe({ a: [{ b: v.slice(3, 9) }] }, 'export', guard)).toThrow(LeakGuardError);
    expect(() => serializeSafe({ [v.slice(0, 8)]: 1 }, 'export', guard)).toThrow(LeakGuardError);
    expect(() => serializeSafe({ x: v }, 'export', guard)).toThrow(LeakGuardError);
  });

  it('passes masked data and returns the exact JSON', () => {
    const gh = fakeGithubClassic(r);
    const guard = guardFor([gh]);
    const masked = maskValue(gh, prefixes).masked;
    const value = { id: 'f1', maskedValue: masked, path: 'src/app.ts', line: 3 };
    expect(serializeSafe(value, 'export', guard)).toBe(JSON.stringify(value));
  });

  it('checks short values as whole values at token boundaries only', () => {
    const short = ['Qz', '7x'].join('');
    const guard = guardFor([short]);
    expect(() => guard.check(`pw ${short} end`, 'note')).toThrow(LeakGuardError);
    expect(() => guard.check(short, 'note')).toThrow(LeakGuardError);
    expect(() => guard.check(`a${short}b`, 'note')).not.toThrow();
    expect(() => guard.check(short.slice(0, 3), 'note')).not.toThrow();
  });

  // what_bug_this_catches: values of length one/two were silently omitted from both matcher and hashed index.
  it('indexes every nonempty short length and checks decoded JSON strings', () => {
    for (const short of ['Q', 'Q7', 'Q7z', 'Q7zy', 'Q7zy9', '"\\', '\u001f']) {
      const guard = guardFor([short]);
      expect((guard.lookup as LeakIndex).shortLengths).toContain(short.length);
      expect(() => guard.check(short, 'note')).toThrow(LeakGuardError);
      expect(() => guard.check(`pin='${short}';`, 'ui_state')).toThrow(LeakGuardError);
      expect(() => serializeSafe({ note: short }, 'note', guard)).toThrow(LeakGuardError);
      expect(() => guard.check(`x${short}x`, 'note')).not.toThrow();
    }
    const maskGuard = guardFor(['*']);
    expect(() => maskGuard.check('*', 'export')).toThrow(LeakGuardError);
  });

  it('exempts a kept prefix only at its kept position (boundary + followed by the mask)', () => {
    const fg = fakeGithubFineGrained(r);
    const kept = ['github', '_pat_'].join('');
    const guard = guardFor([fg]);
    expect(() => guard.check(JSON.stringify({ m: maskValue(fg, prefixes).masked }), 'export')).not.toThrow();
    expect(() => guard.check(`${kept}*****`, 'export')).not.toThrow();
    expect(() => guard.check(`z${kept}*****`, 'export')).toThrow(LeakGuardError);
    expect(() => guard.check(`${kept} mentioned`, 'export')).toThrow(LeakGuardError);
    expect(() => guard.check(fg.slice(0, kept.length + 3), 'export')).toThrow(LeakGuardError);
  });

  it('mask-only n-grams of a placeholder value never block masked output', () => {
    const guard = guardFor(['**********', fakeAwsKeyId(r)]);
    expect(() => guard.check('maskedValue: **********', 'export')).not.toThrow();
  });

  it('retains a separately vetted clean id only as an internal diagnostic; public text stays empty', () => {
    const gh = fakeGithubClassic(r);
    const guard = guardFor([gh]);
    const clean = catchGuard(() => serializeSafe({ n: gh }, 'export', guard, 'fp-123'));
    expect(clean.message).toBe('');
    expect(String(clean)).toBe('');
    expect(clean.findingId).toBe('fp-123');
    const dirtyId = `x:${gh}`;
    const dirty = catchGuard(() => serializeSafe({ n: gh }, 'export', guard, dirtyId));
    expect(containsRawMaterial(dirty.message, gh)).toBe(false);
    expect(dirty.findingId).toBeUndefined();
    const hex = 'a'.repeat(64);
    for (const id of [hex, gh, 'unvetted-fp-123']) {
      const error = new LeakGuardError('ledger', { findingId: id });
      expect(error.message).not.toContain(id);
      expect(error.findingId).toBeUndefined();
      expect(Object.hasOwn(error, 'findingId')).toBe(false);
    }
  });

  // what_bug_this_catches: fixed boundary/boilerplate text (e.g. "export") can itself be an indexed raw value.
  it('emits no public error text for known boundary names, boilerplate or error class names', () => {
    for (const value of ['export', 'boundary', 'possible secret material', 'LeakGuardError', 'unserializable', 'not_ready', 'fp-123']) {
      const guard = guardFor([value]);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const attempts: Array<() => unknown> = [
        () => serializeSafe({ note: value }, 'export', guard, 'fp-123'),
        () => serializeSafe(cyclic, 'export', guard, 'fp-123'),
        () => serializeSafe({ n: BigInt(1) }, 'export', guard, 'fp-123'),
        () => serializeSafe({ note: 'clean' }, 'export', NOT_READY_GUARD, 'fp-123'),
        () => NOT_READY_GUARD.check('clean', 'export', 'fp-123'),
        () => guardedSafeText('clean', 'note', NOT_READY_GUARD, 'fp-123'),
      ];
      for (const attempt of attempts) {
        const error = catchGuard(attempt);
        expect(error.message).toBe('');
        expect(String(error)).toBe('');
        expect(() => guard.check(error.message, 'log')).not.toThrow();
      }
    }
    // Structured fields remain internal and are subject to the same outbound guard as other data.
    const guard = guardFor(['export']);
    const error = catchGuard(() => serializeSafe({ note: 'export' }, 'export', guard));
    expect(() => serializeSafe(error, 'log', guard)).toThrow(LeakGuardError);
  });

  // what_bug_this_catches: hex-shaped HMAC ids bypassed the strict rule through errors thrown before guard.check.
  it('omits a colliding genuine HMAC from serialisation and not-ready errors, including structured fields', async () => {
    const digest = await hmacHex(createSessionSalt(), 'error metadata collision regression');
    const gram = digest.slice(20, 26);
    const raw = randomChars(r, 10, HEX) + gram + randomChars(r, 24, HEX);
    const guard = guardFor([raw]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const attempts: Array<() => unknown> = [
      () => serializeSafe(cyclic, 'export', guard, digest),
      () => serializeSafe({ n: BigInt(1) }, 'export', guard, digest),
      () => serializeSafe({ note: 'clean' }, 'export', NOT_READY_GUARD, digest),
      () => NOT_READY_GUARD.check('clean', 'export', digest),
      () => guardedSafeText('clean', 'note', NOT_READY_GUARD, digest),
      () => guard.check(undefined as unknown as string, 'export', digest),
    ];
    for (const attempt of attempts) {
      const error = catchGuard(attempt);
      expect(error.message).not.toContain(digest);
      expect(error.message).not.toContain(gram);
      expect(error.findingId).toBeUndefined();
      expect(Object.hasOwn(error, 'findingId')).toBe(false);
      expect(JSON.stringify(error)).not.toContain(digest);
      expect(JSON.stringify(error)).not.toContain(gram);
      expect(() => guard.check(error.message, 'log')).not.toThrow();
      expect(() => guard.check(JSON.stringify(error), 'log')).not.toThrow();
    }
  });

  it('unserialisable values fail closed with a masked error', () => {
    const guard = guardFor([fakeGithubClassic(r)]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(catchGuard(() => serializeSafe(cyclic, 'log', guard)).reason).toBe('unserializable');
    expect(catchGuard(() => serializeSafe({ n: BigInt(1) }, 'log', guard)).reason).toBe('unserializable');
  });

  it('NOT_READY_GUARD (after reload) refuses everything until re-import', () => {
    expect(NOT_READY_GUARD.ready).toBe(false);
    expect(catchGuard(() => serializeSafe({ a: 1 }, 'export', NOT_READY_GUARD)).reason).toBe('not_ready');
    expect(catchGuard(() => serializeSafe({ a: 1 }, 'note', NOT_READY_GUARD)).boundary).toBe('note');
    expect(() => guardedSafeText('anything', 'note', NOT_READY_GUARD)).toThrow(LeakGuardError);
  });

  it('guardedSafeText brands clean text and refuses leaking text', () => {
    const gh = fakeGithubClassic(r);
    const guard = guardFor([gh]);
    expect(guardedSafeText('app.ts', 'ui_state', guard)).toBe('app.ts');
    expect(() => guardedSafeText(`app-${gh}.ts`, 'ui_state', guard)).toThrow(LeakGuardError);
  });
});

describe('leak index structure', () => {
  it('holds only numbers (salted hashes / derived key words) — no raw strings, no salt bytes', () => {
    const values = [fakeGithubClassic(r), fakeGithubFineGrained(r), fakeAwsKeyId(r), fakeGenericToken(r, 24), ['Qz', '7x'].join('')];
    const kept = keptFor(values);
    const salt = createSessionSalt();
    const guard = buildLeakGuard(values, kept, salt) as IndexedLeakGuard;
    const { strings, kinds } = walk(guard);
    const allowed = new Set(kept.map((k) => k.prefix));
    // The only strings anywhere in the guard are the fixed provider prefixes it exempts.
    for (const s of strings) expect(allowed.has(s)).toBe(true);
    expect(kinds.has('bigint')).toBe(false);

    const index = guard.lookup as LeakIndex;
    expect(Object.values(index).includes(salt)).toBe(false);
    expect(index.grams.size).toBeGreaterThan(0);
    expect(index.shorts.size).toBe(1);
    for (const [k, v] of index.grams) {
      expect(typeof k).toBe('number');
      expect(typeof v === 'number' || (Array.isArray(v) && v.every((x) => typeof x === 'number'))).toBe(true);
    }
  });

  it('hashes are keyed by the session salt', () => {
    const values = [fakeGenericToken(r, 30)];
    const a = buildLeakIndex(values, createSessionSalt());
    const b = buildLeakIndex(values, createSessionSalt());
    expect([...a.grams.keys()]).not.toEqual([...b.grams.keys()]);
    expect(a.grams.size).toBe(b.grams.size);
  });

  it('detected unreported tokens can be indexed alongside finding values', () => {
    const reported = fakeGithubClassic(r);
    const unreported = fakeGenericToken(r, 40);
    const guard = guardFor([reported, unreported]);
    expect(() => guard.check(`ctx ${unreported.slice(5, 15)}`, 'judge_request')).toThrow(LeakGuardError);
  });
});

// what_bug_this_catches: any caller registering a digest could bypass the strict six-gram rule; genuine HMAC
// collisions must also fail closed. There is no exception for metadata, model text, notes or exports.
describe('digests obey the strict known-value rule', () => {
  function collidingDigest(raw: string): string {
    return randomChars(r, 20, HEX) + raw.slice(5, 11) + randomChars(r, 38, HEX);
  }

  function assertBlocked(guard: IndexedLeakGuard, d: string): void {
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(guard.exemptDigests([d, d])).toBe(0);
    expect(() => guard.check(d, 'export')).toThrow(LeakGuardError);
    for (const field of ['id', 'valueTag', 'note', 'model_text', 'export']) {
      const boundary = field === 'note' ? 'note' : field === 'model_text' ? 'model_text' : 'export';
      expect(() => serializeSafe({ [field]: d }, boundary, guard, d)).toThrow(LeakGuardError);
    }
    const error = catchGuard(() => serializeSafe({ id: d }, 'export', guard, d));
    expect(error.message).not.toContain(d);
  }

  it('a constructed 64-hex value carrying just one known six-gram stays blocked after registration', () => {
    const raw = randomChars(r, 40, HEX);
    assertBlocked(guardFor([raw]), collidingDigest(raw));
  });

  it('a genuine Web Crypto HMAC sharing a known six-gram is also blocked', async () => {
    const digest = await hmacHex(createSessionSalt(), 'synthetic metadata collision regression');
    const raw = randomChars(r, 10, HEX) + digest.slice(20, 26) + randomChars(r, 24, HEX);
    assertBlocked(guardFor([raw]), digest);
  });

  it('clean, noncolliding digests pass without exemptions', () => {
    const guard = guardFor(['a'.repeat(40)]);
    const digest = 'b'.repeat(64);
    expect(guard.exemptDigests([digest])).toBe(0);
    expect(() => guard.check(digest, 'cache')).not.toThrow();
    expect(serializeSafe({ id: digest, valueTag: digest }, 'export', guard))
      .toBe(JSON.stringify({ id: digest, valueTag: digest }));
  });

  it('the compatibility API never accepts anything and keeps no digest registrations', () => {
    const guard = guardFor(['a'.repeat(40)]);
    expect(guard.exemptDigests(['b'.repeat(64), '', 'not a digest'])).toBe(0);
    expect(guard.exemptDigests('nope' as unknown as string[])).toBe(0);
    expect(NOT_READY_GUARD.exemptDigests(['b'.repeat(64)])).toBe(0);
    expect(Object.hasOwn(guard, 'digests')).toBe(false);
  });
});
