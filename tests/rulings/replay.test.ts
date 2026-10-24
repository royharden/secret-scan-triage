import { describe, expect, it } from 'vitest';
import { bindFinding, contentHash } from '../../src/core/rulings/binding.ts';
import { compareRulingEvents, latestRulings, replayRuling } from '../../src/core/rulings/replay.ts';
import { guardedSafeText } from '../../src/core/mask/leakGuard.ts';
import { bindingFor, eventFor, findingFor, guardFor, scope } from './fixtures.ts';

describe('binding and latest-event replay', () => {
  it('changes the content hash on masked context changes and the value tag on T19 replacements', async () => {
    // what_bug_this_catches: hashing only mask shape ignores context; hashing only context ignores equal-mask replacements.
    const first = findingFor();
    const original = await bindFinding(first);
    const changedValue = await bindFinding({ ...first, valueTag: 'c'.repeat(64) });
    expect(changedValue.contentHash).toBe(original.contentHash);
    const events = [eventFor(original)];
    expect(replayRuling(changedValue, events, scope).reason).toBe('value_changed');
    const changedContext = { ...first, maskedWindow: [{ lineId: 'L0', text: guardedSafeText('changed masked context', 'ui_state', guardFor()) }] };
    expect(await contentHash(changedContext)).not.toBe(original.contentHash);
    expect(replayRuling(await bindFinding(changedContext), events, scope).reason).toBe('content_changed');
  });
  it('orders decimal server IDs numerically at equal timestamps, including IDs above safe integer precision', () => {
    // what_bug_this_catches: lexical sort ranks event 9 after 10; Number loses bigint identity distinctions.
    const events = ['9', '10', '9007199254740992', '9007199254740993'].map((eventId) => eventFor({ eventId }));
    expect(latestRulings(events.slice().reverse(), scope).get('finding-a')?.eventId).toBe('9007199254740993');
    expect(compareRulingEvents(events[0], events[1])).toBeLessThan(0);
  });
  it('uses local sequence despite clock rollback and never resurrects an earlier matching approval', () => {
    // what_bug_this_catches: a backward OS clock or changed latest binding brings an obsolete approval back.
    const old = eventFor({ localSeq: 1, createdAt: '2026-10-24T12:00:00Z' });
    const current = eventFor({ localSeq: 2, eventId: '2', createdAt: '2026-10-23T12:00:00Z', valueTag: 'c'.repeat(64), decision: 'real' });
    expect(replayRuling(bindingFor(), [current, old], scope)).toMatchObject({ status: 'changed', event: current });
    expect(replayRuling(bindingFor('other-finding'), [current, old], scope).status).toBe('none');
    expect(replayRuling(bindingFor(), [eventFor({ ownerId: 'other-owner' })], scope).status).toBe('none');
  });
});
