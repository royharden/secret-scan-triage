import type { SupabaseClient } from '@supabase/supabase-js';
import type { Session } from '../app/session.ts';
import type { ConsentState } from './consent.ts';
import { mayUseCloud } from './consent.ts';
import type { LeakGuard } from '../core/safe.ts';
import { serializeSafe } from '../core/safe.ts';
import { promptFingerprint } from '../core/judge/fingerprint.ts';
import { measuredRunCost } from './runAccounting.ts';
export async function saveRunSummary(client: SupabaseClient, userId: string | null, consent: ConsentState, session: Session, guard: LeakGuard, authorized: () => boolean = () => true): Promise<void> {
  if (!authorized() || !mayUseCloud(consent, userId, guard.ready) || !userId || !session.scope || session.scope.ownerId !== userId) throw new Error('');
  const counts = { keep: 0, review: session.blocked, dismiss: 0 };
  for (const item of session.items) counts[item.decision.band]++;
  const live = (session.liveAccounting?.actions ?? 0) > 0 || session.items.some(item => item.judge && item.judge.provider !== 'mock');
  const payload = { user_id: userId, project_key: session.scope.projectKey, source: live ? 'live' : 'scripted-mock', scanner: session.format,
    finding_count: session.candidates, keep_count: counts.keep, review_count: counts.review, dismiss_count: counts.dismiss,
    thresholds_source: session.thresholdsSource ?? 'untuned-default', prompt_fingerprint: await promptFingerprint(),
    cost_usd: live ? measuredRunCost(session.liveAccounting) : null };
  const body = JSON.parse(serializeSafe(payload, 'rulings_cloud', guard));
  if (!authorized()) throw new Error('');
  const { error } = await client.from('triage_runs').insert(body);
  if (error) throw new Error('');
}
