// Session data is memory-only. M3 will add append-only persisted rulings with full binding semantics.
import type { Band, Finding } from '../core/finding.ts';
import type { AuditCohort } from '../core/audit/sampler.ts';
import type { OwnerProject, RulingBinding, RulingEvent } from '../core/rulings/types.ts';
import type { JudgeResult } from '../core/judge/contract.ts';
import type { Decision } from '../core/policy/decide.ts';
import type { LeakGuard } from '../core/safe.ts';
import { serializeSafe } from '../core/safe.ts';
import type { RunLiveAccounting } from '../lib/runAccounting.ts';

export type HumanDecision = 'pending' | 'approved_dismissal' | 'real' | 'skipped';
export interface QueueItem {
  position: number;
  finding: Finding;
  decision: Decision;
  judge: JudgeResult | null;
  human: HumanDecision;
  binding?: RulingBinding;
  ruling?: RulingEvent;
  replayReason?: string;
}
export interface Session {
  items: QueueItem[];
  blocked: number;
  candidates: number;
  format: 'gitleaks' | 'trufflehog';
  demo: boolean;
  runId?: string;
  scope?: OwnerProject;
  cohort?: AuditCohort;
  events?: RulingEvent[];
  thresholdsSource?: 'untuned-default' | 'dev-tuned';
  liveAccounting?: RunLiveAccounting;
  liveBudgetCap?: number;
  liveUsage?: { rows: number; possiblyTruncated: boolean; estimatedUsd: number; actualUsd: number; heldUsd: number } | null;
}

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every((s) => typeof s === 'string'); }
function finite(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function integer(v: unknown): v is number { return finite(v) && Number.isSafeInteger(v) && v >= 0; }

/** Validate the fields consumed by UI/export after guarding every string leaf/key. Unknown worker data fails closed. */
export function readQueueItem(json: string, guard: LeakGuard): QueueItem {
  guard.check(json, 'ui_state');
  const v: unknown = JSON.parse(json);
  serializeSafe(v, 'ui_state', guard);
  if (!record(v) || !integer(v.position) || !record(v.finding) || !record(v.decision)) throw new Error('');
  const f = v.finding;
  const d = v.decision;
  if (!['pending', 'approved_dismissal', 'real', 'skipped'].includes(String(v.human))) throw new Error('');
  if (!['keep', 'review', 'dismiss'].includes(String(d.band)) || ![1, 2].includes(Number(d.stage)) || !strings(d.reasons)) throw new Error('');
  if (!['gitleaks', 'trufflehog'].includes(String(f.scanner)) || f.origin !== f.scanner) throw new Error('');
  for (const key of ['id', 'ruleId', 'path', 'maskedValue', 'valueTag', 'charClass', 'verified', 'verifiedLabel']) {
    if (typeof f[key] !== 'string') throw new Error('');
  }
  if (!integer(f.line) || !integer(f.length) || !record(f.features) || !record(f.flags)) throw new Error('');
  for (const key of ['injection', 'malformedEvidence', 'contextMismatch', 'unmaskableContext']) {
    if (typeof f.flags[key] !== 'boolean') throw new Error('');
  }
  if (!Array.isArray(f.maskedWindow) || f.maskedWindow.length > 7 || !Array.isArray(f.signals)) throw new Error('');
  for (const line of f.maskedWindow) {
    if (!record(line) || typeof line.lineId !== 'string' || typeof line.text !== 'string') throw new Error('');
  }
  for (const signal of f.signals) {
    if (!record(signal) || !record(signal.evidence)) throw new Error('');
    for (const key of ['id', 'name', 'direction', 'strength']) if (typeof signal[key] !== 'string') throw new Error('');
    if (typeof signal.evidence.lineId !== 'string') throw new Error('');
  }
  if (v.judge !== null) {
    if (!record(v.judge) || !['ok', 'failed', 'not_requested'].includes(String(v.judge.status))) throw new Error('');
    if (v.judge.status === 'ok') { if (!finite(v.judge.p_real) || v.judge.p_real < 0 || v.judge.p_real > 1) throw new Error(''); }
    else if (v.judge.p_real !== null) throw new Error('');
    const usage = v.judge.usage;
    if (!record(usage) || !['calls', 'inputTokens', 'outputTokens', 'usd'].every(key => finite(usage[key]) && Number(usage[key]) >= 0)) throw new Error('');
    for (const flag of ['usage_unknown', 'usage_estimated']) if (v.judge[flag] !== undefined && typeof v.judge[flag] !== 'boolean') throw new Error('');
    for (const key of ['reason_code', 'status', 'provider', 'modelId']) if (typeof v.judge[key] !== 'string') throw new Error('');
    if (v.judge.status !== 'ok') v.judge.p_real = Number.NaN;
  }
  return v as unknown as QueueItem;
}

/** Re-check on receipt before ANY row enters React state. A collision omits only that row. */
export function receiveItems(rows: readonly string[], guard: LeakGuard): { items: QueueItem[]; blocked: number } {
  const items: QueueItem[] = [];
  const positions = new Set<number>();
  let blocked = 0;
  for (const row of rows) {
    try {
      const item = readQueueItem(row, guard);
      if (positions.has(item.position)) throw new Error('');
      positions.add(item.position); items.push(item);
    } catch { blocked++; }
  }
  return { items, blocked };
}

export function updateDecision(session: Session, position: number, human: HumanDecision, guard: LeakGuard): Session {
  let blocked = session.blocked;
  const items: QueueItem[] = [];
  for (const item of session.items) {
    if (item.position !== position) { items.push(item); continue; }
    try {
      const next = { ...item, human };
      // Re-read the serialised row so state receives only the exact checked plain-data object.
      items.push(readQueueItem(serializeSafe(next, 'ui_state', guard), guard));
    } catch { blocked++; }
  }
  return { ...session, items, blocked };
}

export function bandCounts(session: Session): Record<Band, number> {
  return session.items.reduce((counts, item) => { counts[item.decision.band]++; return counts; }, { keep: 0, review: 0, dismiss: 0 });
}
