import type { HumanDecision, QueueItem, Session } from './session.ts';
import { sameBinding } from '../core/rulings/binding.ts';
export function visibleBand(item: QueueItem, session: Session): 'keep' | 'review' | 'dismiss' {
  if (item.replayReason) return 'review';
  if (item.decision.band === 'dismiss' && item.binding && session.cohort?.members.some(member => sameBinding(member, item.binding!))) return 'review';
  return item.decision.band;
}
export function queueOrder(session: Session): QueueItem[] {
  const rank = { keep: 0, review: 1, dismiss: 2 };
  return [...session.items].sort((a, b) => rank[visibleBand(a, session)] - rank[visibleBand(b, session)] || a.position - b.position);
}
export function keyboardAction(key: string, current: number, positions: readonly number[]): { position: number; decision?: 'real' | 'approved_dismissal' | 'skipped' } | null {
  if (!positions.length || !['j', 'k', 'r', 'd', 's'].includes(key)) return null;
  const index = Math.max(0, positions.indexOf(current));
  if (key === 'j' || key === 'k') return { position: positions[Math.max(0, Math.min(positions.length - 1, index + (key === 'j' ? 1 : -1)))] };
  return { position: positions[index], decision: key === 'r' ? 'real' : key === 'd' ? 'approved_dismissal' : 'skipped' };
}

export interface NoteDraft { note: string; blocked: boolean }
/** Check before any edit reaches shared React state. Refusal clears the draft instead of reviving a saved note. */
export function guardedNoteDraft(note: string, checkNote: (note: string) => boolean): NoteDraft {
  return note.length <= 500 && checkNote(note) ? { note, blocked: false } : { note: '', blocked: true };
}
export function currentNote(item: QueueItem, drafts: ReadonlyMap<number, NoteDraft>): NoteDraft {
  return drafts.get(item.position) ?? { note: item.ruling?.note ?? '', blocked: false };
}
/** Mouse and keyboard share this exact note source. Focus is requested after the async save settles, even on failure. */
export async function saveQueueDecision(
  item: QueueItem, decision: HumanDecision, drafts: ReadonlyMap<number, NoteDraft>,
  save: (position: number, decision: HumanDecision, note: string) => Promise<void>,
  requestFocus: (position: number) => void,
): Promise<void> {
  try { await save(item.position, decision, currentNote(item, drafts).note); }
  finally { requestFocus(item.position); }
}
/** Retain a selected row that moves beyond the destination band's current page, without rendering the whole band. */
export function renderedQueueItems(items: readonly QueueItem[], visible: number, selected: number): QueueItem[] {
  const shown = items.slice(0, visible);
  const selectedItem = items.find(item => item.position === selected);
  if (selectedItem && !shown.some(item => item.position === selected)) shown.push(selectedItem);
  return shown;
}
interface FocusableRow { closest(selector: 'details'): { open: boolean } | null; focus(): void }
/** Resolve the row at focus time, after the update, so a detached pre-save card is never the target. */
export function restoreQueueFocus(position: number, findRow: (position: number) => FocusableRow | null): boolean {
  const row = findRow(position);
  if (!row) return false;
  const disclosure = row.closest('details');
  if (disclosure) disclosure.open = true;
  row.focus();
  return true;
}
