import type { Finding } from '../../src/core/finding.ts';
import { guardedSafeText } from '../../src/core/mask/leakGuard.ts';
import { buildLeakGuard } from '../../src/core/mask/leakIndex.ts';
import type { OwnerProject, RulingBinding, RulingDraft, RulingEvent } from '../../src/core/rulings/types.ts';

export const scope: OwnerProject = { ownerId: 'local-owner', projectKey: 'local-project' };
export function guardFor(values: string[] = []) { return buildLeakGuard(values, [], new Uint8Array(32).fill(23)); }
export function bindingFor(id = 'finding-a'): RulingBinding {
  return { findingId: id, contentHash: 'a'.repeat(64), valueTag: 'b'.repeat(64) };
}
export function draftFor(over: Partial<RulingDraft> = {}): RulingDraft {
  return { ...scope, ...bindingFor(), decision: 'dismiss_approved', reasonCode: 'human_review', note: '', isAudit: false, ...over };
}
export function eventFor(over: Partial<RulingEvent> = {}): RulingEvent {
  return { ...draftFor(), createdAt: '2026-10-24T12:00:00.000Z', eventId: '1', ...over };
}
export function findingFor(over: Partial<Finding> = {}): Finding {
  const guard = guardFor();
  return {
    id: 'finding-a', scanner: 'gitleaks', origin: 'gitleaks', ruleId: 'sample-rule', path: 'src/sample.ts', line: 5,
    fingerprint: 'abc:src/sample.ts:sample-rule:5', maskedValue: guardedSafeText('********', 'ui_state', guard),
    length: 8, charClass: 'alnum', verified: 'unknown', verifiedLabel: 'unknown', valueTag: 'b'.repeat(64),
    features: { length: 8, charClass: 'alnum', entropy: 1, lengthBucket: 's', entropyBucket: 'low', pathClass: 'source' },
    flags: { injection: false, malformedEvidence: false, contextMismatch: false, unmaskableContext: false }, signals: [],
    maskedWindow: [{ lineId: 'L0', text: guardedSafeText('const value = "********";', 'ui_state', guard) }], ...over,
  };
}
