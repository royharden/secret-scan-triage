import type { LeakGuard } from '../safe.ts';
import { serializeSafe } from '../safe.ts';

export interface OwnerProject { ownerId: string; projectKey: string }
export interface RulingBinding { findingId: string; contentHash: string; valueTag: string }
export type Decision = 'dismiss_approved' | 'real' | 'skip';

export interface RulingDraft extends OwnerProject, RulingBinding {
  decision: Decision;
  reasonCode: string;
  note: string;
  isAudit: boolean;
  auditCohortId?: string;
}
export interface RulingEvent extends RulingDraft {
  /** Decimal server identity, or the decimal IndexedDB sequence. Compare numerically, never lexically. */
  eventId: string;
  createdAt: string;
  /** Present for offline events; monotonic even if the wall clock moves backwards. */
  localSeq?: number;
}
export interface RulingsStore {
  append(draft: RulingDraft, guard: LeakGuard): Promise<RulingEvent>;
  list(scope: OwnerProject): Promise<RulingEvent[]>;
  close(): void;
}
export type RulingsStoreErrorCode = 'invalid_input' | 'unavailable' | 'quota' | 'storage';

/** Code is internal structured state. No browser/database error text is retained or emitted. */
export class RulingsStoreError extends Error {
  code: RulingsStoreErrorCode;
  constructor(code: RulingsStoreErrorCode) {
    super('');
    this.name = 'RulingsStoreError';
    this.code = code;
  }
  override toString(): string { return ''; }
}

/** Shared by the event/cohort adapters; never retain the underlying diagnostic message. */
export function rulingsStorageError(error: unknown): RulingsStoreError {
  return new RulingsStoreError(error !== null && typeof error === 'object' && 'name' in error &&
    error.name === 'QuotaExceededError' ? 'quota' : 'storage');
}

export function sameScope(a: OwnerProject, b: OwnerProject): boolean {
  return a.ownerId === b.ownerId && a.projectKey === b.projectKey;
}
export function validScope(scope: OwnerProject): boolean {
  return typeof scope?.ownerId === 'string' && scope.ownerId.length > 0 &&
    typeof scope.projectKey === 'string' && scope.projectKey.length > 0;
}

/** Shared by offline/cloud adapters: guard before handling the note, then guard the exact emitted draft. */
export function sanitizeRulingDraft(draft: RulingDraft, guard: LeakGuard, boundary: 'rulings_idb' | 'rulings_cloud' = 'rulings_idb'): RulingDraft {
  serializeSafe(draft, boundary, guard, draft?.findingId);
  serializeSafe(draft?.note, 'note', guard, draft?.findingId);
  if (!validScope(draft) || !['dismiss_approved', 'real', 'skip'].includes(draft.decision) ||
    typeof draft.findingId !== 'string' || draft.findingId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(draft.contentHash) || !/^[0-9a-f]{64}$/.test(draft.valueTag) ||
    typeof draft.note !== 'string' || typeof draft.reasonCode !== 'string' ||
    draft.reasonCode.length === 0 || draft.reasonCode.length > 100 || typeof draft.isAudit !== 'boolean' ||
    (draft.auditCohortId !== undefined && (typeof draft.auditCohortId !== 'string' || draft.auditCohortId.length === 0)) ||
    (draft.isAudit && draft.auditCohortId === undefined)) throw new RulingsStoreError('invalid_input');
  const note = draft.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (note.length > 500) throw new RulingsStoreError('invalid_input');
  serializeSafe(note, 'note', guard, draft.findingId);
  const clean: RulingDraft = {
    ownerId: draft.ownerId, projectKey: draft.projectKey, findingId: draft.findingId,
    contentHash: draft.contentHash, valueTag: draft.valueTag, decision: draft.decision,
    reasonCode: draft.reasonCode, note, isAudit: draft.isAudit,
  };
  if (draft.auditCohortId !== undefined) clean.auditCohortId = draft.auditCohortId;
  serializeSafe(clean, boundary, guard, clean.findingId);
  return clean;
}
