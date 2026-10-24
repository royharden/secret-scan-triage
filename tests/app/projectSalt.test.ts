import { describe, expect, it } from 'vitest';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { getProjectSalt, exportProjectIdentity } from '../../src/lib/projectSalt.ts';

describe('client-only project identity salt', () => {
  it('keeps one salt across calls/tabs and returns independent copies', async () => {
    // what_bug_this_catches: recreating the salt on reload breaks ruling/valueTag identity across imports.
    const factory = new FakeIDBFactory();
    const [a, b] = await Promise.all([getProjectSalt(factory), getProjectSalt(factory)]);
    expect(a).toHaveLength(32); expect(a).toEqual(b);
    a.fill(0);
    expect(await getProjectSalt(factory)).toEqual(b);
  });
  it('fails closed when local storage cannot be opened', async () => {
    const factory = { open() { throw new Error('unavailable'); } } as unknown as IDBFactory;
    await expect(getProjectSalt(factory)).rejects.toBeInstanceOf(Error);
  });
});


describe('explicit private identity backup', () => {
  it('requires a ready guard before touching storage', async () => {
    const { NOT_READY_GUARD } = await import('../../src/core/safe.ts');
    const factory = { open() { throw new Error('storage must not open'); } } as unknown as IDBFactory;
    await expect(exportProjectIdentity(NOT_READY_GUARD, factory)).rejects.toBeInstanceOf(Error);
  });
  it('returns the existing salt through the export boundary only', async () => {
    const { buildLeakGuard } = await import('../../src/core/mask/leakIndex.ts');
    const factory = new FakeIDBFactory();
    const salt = await getProjectSalt(factory);
    const guard = buildLeakGuard([], [], new Uint8Array(32).fill(26));
    const backup = JSON.parse(await exportProjectIdentity(guard, factory));
    expect(backup).toEqual({ schemaVersion: 1, kind: 'private-project-identity', projectSalt: Array.from(salt) });
  });
});
