import { sameBinding } from './binding.ts';
import { sameScope } from './types.ts';
import type { OwnerProject, RulingBinding, RulingEvent } from './types.ts';

function decimalOrder(a: string, b: string): number {
  // Identity columns can exceed JS safe integer range. Decimal strings need no BigInt serialization.
  const aa = a.replace(/^0+(?=\d)/, '');
  const bb = b.replace(/^0+(?=\d)/, '');
  return aa.length - bb.length || (aa < bb ? -1 : aa > bb ? 1 : 0);
}
function submillisecondOrder(a: string, b: string): number {
  // Date.parse truncates PostgreSQL's microsecond digits. Offset conversion changes only whole seconds,
  // so compare the remaining decimal fraction after equal epoch milliseconds (without float rounding).
  const tail = (value: string): string => (/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '').slice(3);
  const aa = tail(a); const bb = tail(b);
  const length = Math.max(aa.length, bb.length);
  const left = aa.padEnd(length, '0'); const right = bb.padEnd(length, '0');
  return left < right ? -1 : left > right ? 1 : 0;
}
/** Total deterministic ordering; local sequences take precedence over clocks within the offline store. */
export function compareRulingEvents(a: RulingEvent, b: RulingEvent): number {
  if (a.localSeq !== undefined && b.localSeq !== undefined) return a.localSeq - b.localSeq;
  // Stores normally remain separate. A mixed list still has an explicit, transitive ordering.
  if (a.localSeq !== undefined || b.localSeq !== undefined) return a.localSeq !== undefined ? 1 : -1;
  const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return time || submillisecondOrder(a.createdAt, b.createdAt) || decimalOrder(a.eventId, b.eventId);
}
export function latestRulings(events: readonly RulingEvent[], scope: OwnerProject): Map<string, RulingEvent> {
  const latest = new Map<string, RulingEvent>();
  for (const event of events) {
    if (!sameScope(event, scope)) continue;
    const previous = latest.get(event.findingId);
    if (previous === undefined || compareRulingEvents(event, previous) > 0) latest.set(event.findingId, event);
  }
  return latest;
}
export interface ReplayResult {
  status: 'none' | 'applied' | 'changed';
  event?: RulingEvent;
  reason?: 'content_changed' | 'value_changed' | 'binding_changed';
}
/** Select latest first: a newer mismatching event must never resurrect an older matching approval. */
export function replayRuling(binding: RulingBinding, events: readonly RulingEvent[], scope: OwnerProject): ReplayResult {
  const event = latestRulings(events, scope).get(binding.findingId);
  if (event === undefined) return { status: 'none' };
  if (sameBinding(binding, event)) return { status: 'applied', event };
  const contentChanged = binding.contentHash !== event.contentHash;
  const valueChanged = binding.valueTag !== event.valueTag;
  return { status: 'changed', event, reason: contentChanged && valueChanged ? 'binding_changed' : contentChanged ? 'content_changed' : 'value_changed' };
}
