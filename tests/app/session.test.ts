import { describe, expect, it } from 'vitest';
import { receiveItems, updateDecision } from '../../src/app/session.ts';
import type { QueueItem, Session } from '../../src/app/session.ts';
import { buildLeakGuard } from '../../src/core/mask/leakIndex.ts';
import { NOT_READY_GUARD, unsafeMarkSafe } from '../../src/core/safe.ts';

function item(position: number): QueueItem {
  return {
    position, human: 'pending', judge: null, decision: { band: 'review', stage: 1, reasons: [] },
    finding: {
      id: `finding-${position}`, scanner: 'gitleaks', origin: 'gitleaks', ruleId: 'generic', path: 'src/config.ts', line: 1,
      maskedValue: unsafeMarkSafe('****'), length: 4, charClass: 'mixed', verified: 'unknown', verifiedLabel: 'unknown',
      valueTag: 'f'.repeat(64), features: { length: 4, charClass: 'mixed', entropy: 2, lengthBucket: 'xs', entropyBucket: 'low', pathClass: 'config' },
      signals: [], maskedWindow: [], flags: { injection: false, malformedEvidence: false, contextMismatch: false, unmaskableContext: false },
    },
  };
}

describe('masked in-memory session', () => {
  it('omits malformed and raw rows without retaining their ids or text', () => {
    const raw = ['qR8', 'sT9', 'uV4'].join('');
    const guard = buildLeakGuard([raw], [], new Uint8Array(32).fill(8));
    expect(receiveItems([JSON.stringify({ id: raw }), '{'], guard)).toEqual({ items: [], blocked: 2 });
  });
  it('guards human action text and withholds only the affected row on a collision', () => {
    // what_bug_this_catches: new action labels can themselves reproduce a short known value after the worker is gone.
    const guard = buildLeakGuard(['real'], [], new Uint8Array(32).fill(1));
    const session: Session = { items: [item(0), item(1)], blocked: 0, candidates: 2, format: 'gitleaks', demo: true };
    const approved = updateDecision(session, 0, 'approved_dismissal', guard);
    expect(approved.items[0].human).toBe('approved_dismissal');
    expect(approved.items[0].decision.band).toBe('review');
    const blocked = updateDecision(approved, 0, 'real', guard);
    expect(blocked.items.map((row) => row.position)).toEqual([1]);
    expect(blocked.blocked).toBe(1);
    expect(receiveItems(['{}'], NOT_READY_GUARD)).toEqual({ items: [], blocked: 1 });
  });
});
