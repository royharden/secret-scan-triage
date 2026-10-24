import { serializeSafe } from '../safe.ts';
import type { LeakGuard } from '../safe.ts';
import { sameBinding } from './binding.ts';
import { RulingsStoreError, sameScope, sanitizeRulingDraft, validScope } from './types.ts';
import type { OwnerProject, RulingDraft, RulingEvent, RulingsStore } from './types.ts';

export interface CloudRulingsAuthorization { userId: string | null; cloudStorage: boolean }
export interface RulingCloudInsert {
  user_id: string; project_key: string; finding_id: string; content_hash: string; value_tag: string;
  decision: RulingDraft['decision']; reason_code: string; note: string; is_audit: boolean; audit_cohort_id: string | null;
}
export interface RulingsCloudResult { data: unknown; error: unknown }
export interface RulingsCloudSelect extends PromiseLike<RulingsCloudResult> {
  eq(column: 'user_id' | 'project_key', value: string): RulingsCloudSelect;
  order(column: 'created_at' | 'event_id', options: { ascending: boolean }): RulingsCloudSelect;
  range(from: number, to: number): RulingsCloudSelect;
}
export interface RulingsCloudTable {
  insert(row: RulingCloudInsert): { select(columns: string): { single(): PromiseLike<RulingsCloudResult> } };
  select(columns: string): RulingsCloudSelect;
}
/** Main may wrap the installed Supabase client if its generated fluent generic types differ. */
export interface StructuralSupabaseClient { from(table: 'rulings'): RulingsCloudTable }

// Explicit text cast is essential: PostgREST otherwise emits bigint IDs as imprecise JSON numbers.
export const RULINGS_COLUMNS = 'event_id::text,user_id,project_key,finding_id,content_hash,value_tag,decision,reason_code,note,is_audit,audit_cohort_id,created_at';

function payload(draft: RulingDraft): RulingCloudInsert {
  return { user_id: draft.ownerId, project_key: draft.projectKey, finding_id: draft.findingId,
    content_hash: draft.contentHash, value_tag: draft.valueTag, decision: draft.decision,
    reason_code: draft.reasonCode, note: draft.note, is_audit: draft.isAudit, audit_cohort_id: draft.auditCohortId ?? null };
}
function rowEvent(value: unknown, scope: OwnerProject): RulingEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RulingsStoreError('storage');
  const row = value as Record<string, unknown>;
  const id = typeof row.event_id === 'number' && Number.isSafeInteger(row.event_id) ? String(row.event_id) : row.event_id;
  if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id) || typeof row.created_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.created_at) ||
    !Number.isFinite(Date.parse(row.created_at)) || row.user_id !== scope.ownerId || row.project_key !== scope.projectKey ||
    typeof row.finding_id !== 'string' || row.finding_id.length === 0 || row.finding_id.length > 1024 ||
    typeof row.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.content_hash) ||
    typeof row.value_tag !== 'string' || !/^[0-9a-f]{64}$/.test(row.value_tag) ||
    typeof row.decision !== 'string' || !['dismiss_approved', 'real', 'skip'].includes(row.decision) || typeof row.reason_code !== 'string' ||
    row.reason_code.length === 0 || row.reason_code.length > 100 || typeof row.note !== 'string' || row.note.length > 500 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.note) || typeof row.is_audit !== 'boolean' ||
    (row.audit_cohort_id !== null && (typeof row.audit_cohort_id !== 'string' || row.audit_cohort_id.length === 0 || row.audit_cohort_id.length > 512)) ||
    (row.is_audit && row.audit_cohort_id === null)) throw new RulingsStoreError('storage');
  const event: RulingEvent = {
    ownerId: scope.ownerId, projectKey: scope.projectKey, findingId: row.finding_id, contentHash: row.content_hash, valueTag: row.value_tag,
    decision: row.decision as RulingDraft['decision'], reasonCode: row.reason_code, note: row.note, isAudit: row.is_audit,
    eventId: id, createdAt: row.created_at,
  };
  if (typeof row.audit_cohort_id === 'string') event.auditCohortId = row.audit_cohort_id;
  return event;
}

/** Capability is checked on every operation. Sign-in alone, construction and reads never imply storage consent. */
export class SupabaseRulingsStore implements RulingsStore {
  private client: StructuralSupabaseClient;
  private authorize: () => CloudRulingsAuthorization;
  private closed = false;
  constructor(client: StructuralSupabaseClient, authorize: () => CloudRulingsAuthorization = () => ({ userId: null, cloudStorage: false })) {
    this.client = client;
    this.authorize = authorize;
  }
  private requireAuthorization(scope: OwnerProject): void {
    if (this.closed) throw new RulingsStoreError('unavailable');
    if (!validScope(scope)) throw new RulingsStoreError('invalid_input');
    let authorization: CloudRulingsAuthorization;
    try { authorization = this.authorize(); }
    catch { throw new RulingsStoreError('unavailable'); }
    if (authorization?.cloudStorage !== true || !authorization.userId) throw new RulingsStoreError('unavailable');
    if (authorization.userId !== scope.ownerId) throw new RulingsStoreError('invalid_input');
  }
  async append(draft: RulingDraft, guard: LeakGuard): Promise<RulingEvent> {
    const clean = sanitizeRulingDraft(draft, guard, 'rulings_cloud');
    this.requireAuthorization(clean);
    const sent = JSON.parse(serializeSafe(payload(clean), 'rulings_cloud', guard, clean.findingId)) as RulingCloudInsert;
    let response: RulingsCloudResult;
    try { response = await this.client.from('rulings').insert(sent).select(RULINGS_COLUMNS).single(); }
    catch { throw new RulingsStoreError('storage'); }
    this.requireAuthorization(clean);
    if (!response || response.error !== null) throw new RulingsStoreError('storage');
    serializeSafe(response.data, 'rulings_cloud', guard, clean.findingId);
    const event = rowEvent(response.data, clean);
    if (!sameScope(event, clean) || !sameBinding(event, clean) || JSON.stringify(payload(event)) !== JSON.stringify(sent)) throw new RulingsStoreError('storage');
    serializeSafe(event, 'rulings_cloud', guard, clean.findingId);
    return event;
  }
  async list(scope: OwnerProject): Promise<RulingEvent[]> {
    const events: RulingEvent[] = [];
    const identities = new Set<string>();
    for (;;) {
      this.requireAuthorization(scope);
      let response: RulingsCloudResult;
      try {
        response = await this.client.from('rulings').select(RULINGS_COLUMNS)
          .eq('user_id', scope.ownerId).eq('project_key', scope.projectKey)
          .order('created_at', { ascending: true }).order('event_id', { ascending: true })
          .range(events.length, events.length + 499);
      } catch { throw new RulingsStoreError('storage'); }
      this.requireAuthorization(scope);
      if (!response || response.error !== null || !Array.isArray(response.data)) throw new RulingsStoreError('storage');
      // Continue until empty even when the server applies a page cap lower than our requested range.
      if (response.data.length === 0) return events;
      for (const row of response.data) {
        const event = rowEvent(row, scope);
        if (identities.has(event.eventId)) throw new RulingsStoreError('storage');
        identities.add(event.eventId); events.push(event);
      }
    }
    // No guard exists after reload; prepareJourney re-guards restored events before UI state.
  }
  close(): void { this.closed = true; } // Does not sign out or mutate a shared client.
}
