// M5's fake-client Supabase suite imports this same contract with its own store factory.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayRuling } from '../../src/core/rulings/replay.ts';
import type { RulingsStore } from '../../src/core/rulings/types.ts';
import { LeakGuardError, NOT_READY_GUARD } from '../../src/core/safe.ts';
import { bindingFor, draftFor, guardFor, scope } from './fixtures.ts';

export function defineRulingsStoreContract(name: string, factory: () => RulingsStore | Promise<RulingsStore>, options: { rejectForeignOwner?: boolean } = {}): void {
  describe(`${name}: shared rulings semantics`, () => {
    let store: RulingsStore;
    beforeEach(async () => { store = await factory(); });
    afterEach(() => store?.close());
    it('appends reversals and replays only the latest scope-owned event', async () => {
      // what_bug_this_catches: overwriting approval history or replaying a different owner/project's ruling.
      const first = await store.append(draftFor(), guardFor());
      const reversed = await store.append(draftFor({ decision: 'real' }), guardFor());
      if (options.rejectForeignOwner) await expect(store.append(draftFor({ ownerId: 'other-owner' }), guardFor())).rejects.toMatchObject({ code: 'invalid_input' });
      else await store.append(draftFor({ ownerId: 'other-owner' }), guardFor());
      await store.append(draftFor({ projectKey: 'other-project' }), guardFor());
      const events = await store.list(scope);
      expect(events).toHaveLength(2);
      expect(events.find((event) => event.eventId === first.eventId)?.decision).toBe('dismiss_approved');
      expect(replayRuling(bindingFor(), events, scope)).toEqual({ status: 'applied', event: reversed });
    });
    it('requires value AND masked context equality, without reviving an older matching approval', async () => {
      // what_bug_this_catches: T19 same-fingerprint/equal-mask replacement silently inheriting an approval.
      await store.append(draftFor(), guardFor());
      const current = await store.append(draftFor({ contentHash: 'c'.repeat(64), valueTag: 'd'.repeat(64) }), guardFor());
      const events = await store.list(scope);
      expect(replayRuling(bindingFor(), events, scope).status).toBe('changed');
      expect(replayRuling({ ...bindingFor(), contentHash: current.contentHash, valueTag: current.valueTag }, events, scope).status).toBe('applied');
      expect(replayRuling({ ...bindingFor(), contentHash: current.contentHash }, events, scope).reason).toBe('value_changed');
      expect(replayRuling({ ...bindingFor(), valueTag: current.valueTag }, events, scope).reason).toBe('content_changed');
    });
    it('guards notes and refuses all persistence after reload until re-import', async () => {
      // what_bug_this_catches: storing a raw note or reporting success while the session guard is absent.
      await expect(store.append(draftFor({ note: 'danger' }), guardFor(['danger']))).rejects.toBeInstanceOf(LeakGuardError);
      await expect(store.append(draftFor(), NOT_READY_GUARD)).rejects.toBeInstanceOf(LeakGuardError);
      expect(await store.list(scope)).toEqual([]);
      await expect(store.append(draftFor(), guardFor())).resolves.toMatchObject({ decision: 'dismiss_approved' });
    });
    it('checks exact sanitized text and enforces the 500-character note limit', async () => {
      // what_bug_this_catches: removing controls creates a secret only after an initial guard check.
      await expect(store.append(draftFor({ note: 'da\u0000ng\u0000er' }), guardFor(['danger']))).rejects.toBeInstanceOf(LeakGuardError);
      await expect(store.append(draftFor({ note: 'x'.repeat(501) }), guardFor())).rejects.toMatchObject({ code: 'invalid_input' });
      const event = await store.append(draftFor({ note: '  reviewed\u0000 safely  ' }), guardFor());
      expect(event.note).toBe('reviewed safely');
      expect((await store.list(scope))[0].note).toBe('reviewed safely');
    });
  });
}
