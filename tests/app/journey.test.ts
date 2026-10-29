import { describe, expect, it, vi } from 'vitest';
import { processImport } from '../../src/worker/importReport.ts';
import { restoreGuard } from '../../src/core/mask/guardSnapshot.ts';
import { pipelineConfig } from '../../src/core/pipeline.ts';
import { receiveItems } from '../../src/app/session.ts';
import type { Session } from '../../src/app/session.ts';
import { LOCAL_SCOPE, prepareJourney, rulingDraft } from '../../src/app/journey.ts';
import { currentNote, guardedNoteDraft, keyboardAction, queueOrder, renderedQueueItems, restoreQueueFocus, saveQueueDecision, visibleBand } from '../../src/app/keyboard.ts';
import type { NoteDraft } from '../../src/app/keyboard.ts';
import { createAuditCohort } from '../../src/core/audit/sampler.ts';
import type { RulingDraft, RulingEvent } from '../../src/core/rulings/types.ts';
import { buildLeakGuard } from '../../src/core/mask/leakIndex.ts';
import { serializeSafe } from '../../src/core/safe.ts';
import { exportGitleaksIgnore } from '../../src/core/export/gitleaksignore.ts';

const salt = new Uint8Array(32).fill(26);
const raw = ['Gq7', 'Rm9', 'Tz2', 'Wx4', 'Yn8', 'Pp6'].join('');
function report(value: string): File {
  return new File([JSON.stringify([{ RuleID: 'generic-api-key', File: 'src/config.ts', StartLine: 1,
    Fingerprint: 'src/config.ts:generic-api-key:1', Secret: value, Match: `const key = '${value}'` }])], 'scan.json');
}
async function importOne(value: string) {
  const result = await processImport({ kind: 'file', file: report(value), format: 'gitleaks', verificationEnabled: false, projectSalt: salt });
  const guard = restoreGuard(result.snapshot, pipelineConfig().prefixes);
  const received = receiveItems(result.rows, guard);
  const base: Session = { ...received, candidates: result.candidates, format: result.format, demo: false };
  return { guard, base };
}
describe('M3 page journey contracts (unexecuted in Dirty Mode)', () => {
  it('an unsafe latest reversal blocks replay rather than reviving an older dismissal, even with changed binding', async () => {
    // what_bug_this_catches: filtering event 2 before ordering made event 1 an eligible current approval again.
    const input = await importOne(raw);
    const prepared = await prepareJourney(input.base, [], LOCAL_SCOPE, input.guard);
    const item = prepared.items[0];
    const approved: RulingEvent = { ...rulingDraft(prepared, item, 'approved_dismissal', ''),
      eventId: '1', localSeq: 1, createdAt: '2026-10-24T12:00:00.000Z' };
    const blockedNote = 'rotated-on-Friday';
    // This note was safe with the prior import; an additional newly reported value now indexes its six-grams.
    expect(() => serializeSafe(blockedNote, 'note', input.guard)).not.toThrow();
    const freshGuard = buildLeakGuard([raw, blockedNote], [], new Uint8Array(32).fill(31));
    expect(() => serializeSafe(approved, 'ui_state', freshGuard)).not.toThrow();
    for (const changedBinding of [false, true]) {
      const reversal: RulingEvent = { ...approved, decision: 'real', note: blockedNote, localSeq: 2, eventId: '2',
        ...(changedBinding ? { valueTag: 'f'.repeat(64) } : {}) };
      expect(() => serializeSafe(reversal, 'ui_state', freshGuard)).toThrow();
      const restored = await prepareJourney(input.base, [reversal, approved], LOCAL_SCOPE, freshGuard);
      expect(restored.items).toHaveLength(1);
      const current = restored.items[0];
      expect(current.human).toBe('pending');
      expect(current.ruling).toBeUndefined();
      expect(current.replayReason).toBe('saved_event_blocked');
      expect(visibleBand(current, restored)).toBe('review');
      expect(restored.events).toEqual([]);
      expect(serializeSafe(restored, 'ui_state', freshGuard)).not.toContain(blockedNote);
      const proposal = exportGitleaksIgnore([{ finding: current.finding, band: current.decision.band, ruling: current.ruling }],
        new Map([[current.finding.id, current.binding!]]), LOCAL_SCOPE, freshGuard);
      expect(proposal.included).toBe(0);
      expect(proposal.text).toBe('');
    }
  });

  it('D/R/S and corresponding buttons append the same guarded edited note, including a saved-note reversal', async () => {
    // what_bug_this_catches: keyboard saved ruling.note while mouse saved the separate textarea draft.
    const input = await importOne(raw);
    const prepared = await prepareJourney(input.base, [], LOCAL_SCOPE, input.guard);
    const saved: RulingEvent = { ...rulingDraft(prepared, prepared.items[0], 'approved_dismissal', 'previous note'),
      eventId: '1', localSeq: 1, createdAt: '2026-10-24T12:00:00.000Z' };
    const item = { ...prepared.items[0], ruling: saved, human: 'approved_dismissal' as const };
    const notes = new Map<number, NoteDraft>();
    const check = (note: string) => { try { serializeSafe(note, 'note', input.guard); return true; } catch { return false; } };
    notes.set(item.position, guardedNoteDraft('edited safe note', check));
    const appended: RulingDraft[] = [];
    const append = async (_position: number, decision: typeof item.human | 'real' | 'skipped' | 'pending', note: string) => {
      appended.push(rulingDraft(prepared, item, decision, note));
    };
    for (const key of ['d', 'r', 's']) {
      const action = keyboardAction(key, item.position, [item.position])!;
      await saveQueueDecision(item, action.decision!, notes, append, () => undefined); // keyboard path
      await saveQueueDecision(item, action.decision!, notes, append, () => undefined); // matching button path
      expect(appended.at(-1)).toEqual(appended.at(-2));
      expect(appended.at(-1)?.note).toBe('edited safe note');
    }
    notes.set(item.position, guardedNoteDraft(raw, check));
    expect(currentNote(item, notes)).toEqual({ note: '', blocked: true });
    await saveQueueDecision(item, 'real', notes, append, () => undefined);
    expect(appended.at(-1)?.note).toBe(''); // Refusal cannot silently restore the old saved note.
    expect(JSON.stringify([...notes.values()])).not.toContain(raw);
    expect(currentNote(item, new Map()).note).toBe('previous note'); // Fresh session has no stale draft map.
  });

  it('requests focus only after save settles and resolves the remounted row in keep or collapsed dismissals', async () => {
    // what_bug_this_catches: focusing the review card before append loses focus when replayReason clears its band.
    const input = await importOne(raw);
    const prepared = await prepareJourney(input.base, [], LOCAL_SCOPE, input.guard);
    for (const band of ['keep', 'dismiss'] as const) {
      const item = { ...prepared.items[0], position: 99, replayReason: 'value_changed', decision: { ...prepared.items[0].decision, band } };
      const session = { ...prepared, items: [item], cohort: createAuditCohort('focus-run', [], 26) };
      expect(visibleBand(item, session)).toBe('review');
      const oldFocus = vi.fn();
      const newFocus = vi.fn();
      const disclosure = { open: false };
      let row = { closest: () => null as { open: boolean } | null, focus: oldFocus };
      let finish!: () => void;
      const save = new Promise<void>(resolve => { finish = resolve; });
      const request = vi.fn((position: number) => restoreQueueFocus(position, () => row));
      const pending = saveQueueDecision(item, 'real', new Map(), async () => save, request);
      expect(request).not.toHaveBeenCalled();
      const moved = { ...item, replayReason: undefined };
      expect(visibleBand(moved, { ...session, items: [moved] })).toBe(band);
      const destination = [...Array.from({ length: 35 }, (_, position) => ({ ...moved, position })), moved];
      expect(renderedQueueItems(destination, 30, moved.position).map(item => item.position)).toContain(99);
      expect(renderedQueueItems(destination, 30, moved.position)).toHaveLength(31);
      // The renderer has replaced the old card; the post-settlement request must resolve this new node.
      row = { closest: () => band === 'dismiss' ? disclosure : null, focus: newFocus };
      finish();
      await pending;
      expect(oldFocus).not.toHaveBeenCalled();
      expect(newFocus).toHaveBeenCalledOnce();
      if (band === 'dismiss') expect(disclosure.open).toBe(true);
      expect(request).toHaveBeenCalledWith(99);
    }
    const focused = vi.fn();
    const failed = saveQueueDecision(prepared.items[0], 'real', new Map(), async () => { throw new Error(''); },
      position => { restoreQueueFocus(position, () => ({ closest: () => null, focus: focused })); });
    await expect(failed).rejects.toThrow();
    expect(focused).toHaveBeenCalledOnce();
  });

  it('replays only current binding and invalidates equal-mask replacement', async () => {
    // what_bug_this_catches: a stable scanner fingerprint must not revive approval for a replaced secret.
    const first = await importOne(raw);
    const session = await prepareJourney(first.base, [], LOCAL_SCOPE, first.guard);
    expect(session.items).toHaveLength(1);
    const event: RulingEvent = { ...rulingDraft(session, session.items[0], 'approved_dismissal', ''), eventId: '1', localSeq: 1, createdAt: '2026-10-24T12:00:00.000Z' };
    expect((await prepareJourney(first.base, [event], LOCAL_SCOPE, first.guard)).items[0].human).toBe('approved_dismissal');
    const second = await importOne(['Hq7', 'Sn9', 'Uz2', 'Vx4', 'Zo8', 'Qp6'].join(''));
    const changed = await prepareJourney(second.base, [event], LOCAL_SCOPE, second.guard);
    expect(changed.items[0].human).toBe('pending');
    expect(changed.items[0].replayReason).toBe('value_changed');
    expect(visibleBand(changed.items[0], changed)).toBe('review');
  });
  it('injects audit rows without altering automated bands and preserves keyboard positions', async () => {
    const input = await importOne(raw);
    const prepared = await prepareJourney(input.base, [], LOCAL_SCOPE, input.guard);
    const item = { ...prepared.items[0], decision: { ...prepared.items[0].decision, band: 'dismiss' as const } };
    const session = { ...prepared, items: [item], cohort: createAuditCohort('run', [item.binding!], 26) };
    expect(visibleBand(item, session)).toBe('review');
    expect(item.decision.band).toBe('dismiss');
    expect(queueOrder(session)[0].position).toBe(item.position);
    expect(keyboardAction('r', item.position, [item.position])).toEqual({ position: item.position, decision: 'real' });
    expect(keyboardAction('j', 3, [3, 8])).toEqual({ position: 8 });
    expect(keyboardAction('x', 3, [3])).toBeNull();
  });
  it('reads selected context only in worker and skips oversized files before text()', async () => {
    const text = vi.fn(async () => 'must not read');
    const result = await processImport({ kind: 'file', file: report(raw), format: 'auto', verificationEnabled: false, projectSalt: salt,
      selectedFiles: [{ path: 'repo/src/config.ts', file: { size: 1_000_001, text } as unknown as File }], radius: 3 });
    expect(text).not.toHaveBeenCalled();
    expect(result.contextSkipped).toBe(1);
  });
});
