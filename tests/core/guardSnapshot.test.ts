import { describe, expect, it } from 'vitest';
import { buildLeakGuard } from '../../src/core/mask/leakIndex.ts';
import { restoreGuard, snapshotGuard } from '../../src/core/mask/guardSnapshot.ts';
import { LeakGuardError, serializeSafe } from '../../src/core/safe.ts';
import { fakeGithubFineGrained, rng, walk } from './_helpers.ts';

describe('session-only guard transport', () => {
  it('preserves n-grams, short whole values and kept-position prefixes after structured clone', () => {
    // what_bug_this_catches: a worker guard cannot be postMessaged; dropping its methods/index would disable later exports.
    const prefix = ['github', '_pat_'].join('');
    const value = fakeGithubFineGrained(rng(26));
    const short = ['x', 'Y', '7'].join('');
    const guard = buildLeakGuard([value, short], [{ value, prefix }], new Uint8Array(32).fill(26));
    const snapshot = snapshotGuard(guard, [prefix]);
    expect(walk(snapshot).strings).toEqual([]);
    expect(walk(snapshot).kinds.has('function')).toBe(false);
    const restored = restoreGuard(structuredClone(snapshot), [prefix]);
    expect(() => serializeSafe({ value: prefix + '*'.repeat(value.length - prefix.length) }, 'export', restored)).not.toThrow();
    expect(() => restored.check(value.slice(-6), 'export')).toThrow(LeakGuardError);
    expect(() => restored.check(short, 'note')).toThrow(LeakGuardError);
    expect(() => restored.check(`a${short}b`, 'note')).not.toThrow();
    expect(() => restored.check(prefix, 'export')).toThrow(LeakGuardError);
    snapshot.key.fill(0); // Reconstruction owns its key data, not the received mutable buffer.
    expect(() => restored.check(value, 'export')).toThrow(LeakGuardError);
  });

  it('rejects malformed metadata and retains the no-digest-exemption rule', () => {
    const guard = buildLeakGuard(['a'.repeat(12)], [], new Uint8Array(32).fill(2));
    const snapshot = snapshotGuard(guard, []);
    expect(() => restoreGuard({ ...snapshot, version: 2 }, [])).toThrow();
    expect(() => restoreGuard({ ...snapshot, key: new Uint32Array(5) }, [])).toThrow();
    expect(() => restoreGuard({ ...snapshot, grams: new Uint32Array(1) }, [])).toThrow();
    expect(() => restoreGuard({ ...snapshot, prefixIndices: [0] }, [])).toThrow();
    expect(() => restoreGuard({ ...snapshot, shortLengths: [0] }, [])).toThrow();
    expect(() => restoreGuard({ ...snapshot, raw: 'unexpected' }, [])).toThrow();
    const restored = restoreGuard(snapshot, []);
    expect(restored.exemptDigests(['a'.repeat(64)])).toBe(0);
    expect(() => restored.check('a'.repeat(64), 'export')).toThrow(LeakGuardError);
  });
});
