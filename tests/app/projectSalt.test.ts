import { describe, expect, it } from 'vitest';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { getProjectSalt } from '../../src/lib/projectSalt.ts';

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
