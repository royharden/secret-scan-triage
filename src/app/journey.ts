import type { Session, HumanDecision, QueueItem } from './session.ts';
import { readQueueItem } from './session.ts';
import { serializeSafe } from '../core/safe.ts';
import type { LeakGuard } from '../core/safe.ts';
import { bindFinding, sameBinding } from '../core/rulings/binding.ts';
import { latestRulings, replayRuling } from '../core/rulings/replay.ts';
import type { OwnerProject, RulingDraft, RulingEvent } from '../core/rulings/types.ts';
import { createAuditCohort } from '../core/audit/sampler.ts';
import { hmacHex } from '../core/identity.ts';

export const LOCAL_SCOPE: OwnerProject = Object.freeze({ ownerId: 'offline', projectKey: 'local-default' });
export function humanDecision(event: RulingEvent): HumanDecision {
  return event.decision === 'dismiss_approved' ? 'approved_dismissal' : event.decision === 'real' ? 'real' : 'skipped';
}
/** Cloud-only identity boundary, before binding/replay. Original fingerprints remain client-side for ignore download. */
export async function mapCloudFindingIds(session: Session, scope: OwnerProject, projectSalt: Uint8Array, guard: LeakGuard): Promise<Session> {
  if (scope.ownerId === LOCAL_SCOPE.ownerId) return session;
  const items: QueueItem[] = [];
  let blocked = session.blocked;
  for (const item of session.items) {
    try {
      const id = await hmacHex(projectSalt, JSON.stringify(['secret-scan-triage/cloud-finding-id/v1',
        scope.ownerId, scope.projectKey, item.finding.id]));
      guard.check(id, 'ui_state'); // Derived hashes have no exemption from the strict known-value rule.
      const mapped = { ...item, finding: { ...item.finding, id } };
      items.push(readQueueItem(serializeSafe(mapped, 'ui_state', guard), guard));
    } catch { blocked++; } // No fallback to a path-bearing operational id; omitted items cannot produce cloud drafts.
  }
  return { ...session, items, blocked };
}
/** Restored events are untrusted until checked against this fresh import's session guard. */
export async function prepareJourney(session: Session, events: readonly RulingEvent[], scope: OwnerProject, guard: LeakGuard): Promise<Session> {
  const safeEvents: RulingEvent[] = [];
  const blockedLatest = new Set<string>();
  // Ordering must see the complete history. Dropping an unsafe reversal before selection revives old approvals.
  for (const [findingId, event] of latestRulings(events, scope)) {
    try { safeEvents.push(JSON.parse(serializeSafe(event, 'ui_state', guard)) as RulingEvent); }
    catch { blockedLatest.add(findingId); /* Keep only the internal barrier, never the blocked event/note. */ }
  }
  const items: QueueItem[] = [];
  let blocked = session.blocked;
  for (const item of session.items) {
    try {
      const binding = await bindFinding(item.finding);
      const replay = replayRuling(binding, safeEvents, scope);
      const latestBlocked = blockedLatest.has(binding.findingId);
      const next = { ...item, binding, human: !latestBlocked && replay.status === 'applied' && replay.event ? humanDecision(replay.event) : 'pending',
        ruling: !latestBlocked && replay.status === 'applied' ? replay.event : undefined,
        replayReason: latestBlocked ? 'saved_event_blocked' : replay.status === 'changed' ? replay.reason : undefined };
      items.push(readQueueItem(serializeSafe(next, 'ui_state', guard), guard));
    } catch { blocked++; }
  }
  const runId = globalThis.crypto.randomUUID();
  const cohort = createAuditCohort(runId, items.filter(item => item.decision.band === 'dismiss').map(item => item.binding!), 26024);
  // No audit marker is added to the label shown to the reviewer. Membership only affects queue position and later statistics.
  serializeSafe(cohort, 'ui_state', guard);
  return { ...session, items, blocked, runId, scope, cohort, events: safeEvents };
}
export function rulingDraft(session: Session, item: QueueItem, human: HumanDecision, note: string): RulingDraft {
  if (!session.scope || !item.binding || !session.cohort || human === 'pending') throw new Error('');
  const isAudit = session.cohort.members.some(member => sameBinding(member, item.binding!));
  return { ...session.scope, ...item.binding, decision: human === 'approved_dismissal' ? 'dismiss_approved' : human === 'real' ? 'real' : 'skip',
    reasonCode: 'manual_review', note, isAudit, ...(isAudit ? { auditCohortId: session.cohort.id } : {}) };
}
