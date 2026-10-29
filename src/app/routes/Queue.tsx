import { useLayoutEffect, useRef, useState } from 'react';
import type { Band } from '../../core/finding.ts';
import type { HumanDecision, QueueItem, Session } from '../session.ts';
import { currentNote, guardedNoteDraft, keyboardAction, queueOrder, renderedQueueItems, restoreQueueFocus, saveQueueDecision, visibleBand } from '../keyboard.ts';
import type { NoteDraft } from '../keyboard.ts';

interface Props {
  session: Session;
  saving: boolean;
  onLive?: () => void;
  liveEnabled?: boolean;
  onSaveSummary?: () => void;
  canCloud?: boolean;
  checkNote: (note: string) => boolean;
  onDecision: (position: number, decision: HumanDecision, note?: string) => Promise<void>;
  onExport: (format: 'json' | 'csv' | 'markdown' | 'ignore') => void;
  onClear: () => void;
}
const humanLabels: Record<HumanDecision, string> = {
  pending: 'Awaiting a decision', approved_dismissal: 'Dismissal approved', real: 'Marked real', skipped: 'Skipped',
};
const bandCopy: Record<Band, { title: string; hint: string }> = {
  keep: { title: 'Keep', hint: 'Treat these as real findings first.' },
  review: { title: 'Review', hint: 'Human judgment is needed.' },
  dismiss: { title: 'Suggested dismissals', hint: 'Suggestions stay pending until you approve them.' },
};

interface CardActions {
  onDecision: (position: number, decision: HumanDecision) => void;
  noteFor: (item: QueueItem) => NoteDraft;
  onNote: (position: number, note: string) => void;
}
function FindingCard({ item, onDecision, saving, noteFor, onNote }: { item: QueueItem; saving: boolean } & CardActions) {
  const { note, blocked: noteBlocked } = noteFor(item);
  const f = item.finding;
  const titleId = `finding-${item.position}`;
  return (
    <article id={`row-${item.position}`} data-position={item.position} tabIndex={0} className={`finding-card ${item.human !== 'pending' ? 'decided' : ''}`} aria-labelledby={titleId}>
      <div className="finding-topline"><span className="scanner-label">{f.scanner}</span><span className={`verification ${f.verified === 'verified' ? 'verified' : ''}`}>{f.verifiedLabel}</span><span className="human-status">{humanLabels[item.human]}</span></div>
      <h4 id={titleId}><code>{f.ruleId}</code></h4>
      <p className="finding-path"><code>{f.path || '(path unavailable)'}</code><span>line {f.line}</span></p>
      <div className="masked-value"><span className="mini-label">Masked value</span><code>{f.maskedValue}</code><small>{f.length} characters · {f.charClass}</small></div>
      {f.flags.injection && <p className="flag">Untrusted instructions detected near this finding. They are never evidence.</p>}
      {f.flags.contextMismatch && <p className="flag">Context mismatch: using the scanner match line.</p>}
      {f.flags.unmaskableContext && <p className="flag">A context line was withheld because it could not be safely masked.</p>}
      <ul className="decision-reasons">{item.decision.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
      <div className="judge-line">{item.judge ? <><span className="mini-label">{item.judge.provider === 'mock' ? 'Scripted mock judge' : `${item.judge.provider} / ${item.judge.modelId}`}</span><span>{item.judge.status === 'ok' ? `p_real ${item.judge.p_real.toFixed(2)} · ${item.judge.reason_code}` : 'Judge unavailable or failed; review required'}</span>{item.judge.usage_unknown && <small>Returned usage unknown; server reservations may remain.</small>}{item.judge.usage_estimated && <small>Usage contains conservative estimates.</small>}</> : <span>Deterministic decision · judge not requested</span>}</div>
      {item.judge?.model_text && <p className="field-hint">Model-authored: {item.judge.model_text}</p>}
      <details className="evidence">
        <summary>Context & signal evidence <span>({f.signals.length} signals)</span></summary>
        {f.maskedWindow.length > 0 ? <pre>{f.maskedWindow.map((line) => <span key={line.lineId}><b>{line.lineId}</b> {line.text}{'\n'}</span>)}</pre> : <p>Context unavailable or withheld.</p>}
        {f.signals.length > 0 ? <ul>{f.signals.map((signal, i) => <li key={`${signal.id}-${i}`}><strong>{signal.id}</strong> {signal.name} · {signal.direction} / {signal.strength} · {signal.evidence.lineId}{typeof signal.evidence.start === 'number' && typeof signal.evidence.end === 'number' ? ` [${signal.evidence.start}, ${signal.evidence.end})` : ''}</li>)}</ul> : <p>No deterministic signals on this span.</p>}
      </details>
      {item.replayReason && <p className="flag">Saved decision invalidated: {item.replayReason.replaceAll('_', ' ')}. Review the changed finding.</p>}
      <label className="note-label" htmlFor={`note-${item.position}`}>Optional note (500 characters maximum)</label>
      <textarea id={`note-${item.position}`} value={note} maxLength={500} disabled={saving} onChange={event => onNote(item.position, event.target.value)} rows={2} />
      {noteBlocked && <p role="alert">The note was withheld by the leak guard. Use a note without credential material.</p>}
      <div className="finding-actions" aria-label={`Decision for finding ${item.position + 1}`}>
        <button className="action-real" aria-pressed={item.human === 'real'} disabled={saving} onClick={() => onDecision(item.position, 'real')}>Mark real</button>
        <button aria-pressed={item.human === 'approved_dismissal'} disabled={saving} onClick={() => onDecision(item.position, 'approved_dismissal')}>Approve dismissal</button>
        <button className="text-button" aria-pressed={item.human === 'skipped'} disabled={saving} onClick={() => onDecision(item.position, 'skipped')}>Skip</button>
      </div>
    </article>
  );
}

function BandList({ band, items, selected, onDecision, saving, noteFor, onNote }: { band: Band; items: QueueItem[]; selected: number; saving: boolean } & CardActions) {
  const [visible, setVisible] = useState(30);
  const shown = renderedQueueItems(items, visible, selected);
  return <>
    {items.length === 0 ? <p className="band-empty">No findings in this band.</p> : <div className="finding-list">{shown.map((item) => <FindingCard key={item.position} item={item} onDecision={onDecision} saving={saving} noteFor={noteFor} onNote={onNote} />)}</div>}
    {items.length > shown.length && <button className="secondary show-more" onClick={() => setVisible((n) => n + 30)}>Show 30 more {bandCopy[band].title.toLowerCase()} findings ({items.length - shown.length} remaining)</button>}
  </>;
}

export function Queue({ session, saving, checkNote, onDecision, onExport, onClear, onLive, liveEnabled, onSaveSummary, canCloud }: Props) {
  const ordered = queueOrder(session);
  const [selected, setSelected] = useState(ordered[0]?.position ?? 0);
  const [notes, setNotes] = useState<Map<number, NoteDraft>>(() => new Map());
  const [focusRequest, setFocusRequest] = useState<{ position: number; sequence: number } | null>(null);
  const focusSequence = useRef(0);
  const requestFocus = (position: number) => setFocusRequest({ position, sequence: ++focusSequence.current });
  useLayoutEffect(() => {
    if (focusRequest && !saving) restoreQueueFocus(focusRequest.position, position => document.getElementById(`row-${position}`));
  }, [focusRequest, saving, session]);
  const onNote = (position: number, note: string) => {
    const draft = guardedNoteDraft(note, checkNote); // Never retain unchecked input in state.
    setNotes(current => new Map(current).set(position, draft));
  };
  const submit = async (position: number, decision: HumanDecision) => {
    if (saving) return;
    const item = session.items.find(row => row.position === position);
    if (!item) return;
    setSelected(position);
    setFocusRequest(null);
    try { await saveQueueDecision(item, decision, notes, onDecision, requestFocus); }
    catch { /* App owns the guarded/fixed save-failure notice. Focus is still requested in finally. */ }
  };
  const actions: CardActions = { onDecision: (position, decision) => { void submit(position, decision); },
    noteFor: item => currentNote(item, notes), onNote };
  const counts: Record<Band, number> = { keep: 0, review: 0, dismiss: 0 };
  for (const item of session.items) counts[visibleBand(item, session)]++;
  const decided = session.items.filter((item) => item.human !== 'pending').length;
  return (
    <section className="queue-panel" aria-labelledby="queue-heading" onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (saving || target.closest('input,textarea,select,[contenteditable=true]') || event.altKey || event.ctrlKey || event.metaKey) return;
      const position = Number(target.closest('[data-position]')?.getAttribute('data-position') ?? selected);
      const action = keyboardAction(event.key.toLowerCase(), position, ordered.filter(item => document.getElementById(`row-${item.position}`)).map(item => item.position));
      if (!action) return;
      event.preventDefault(); setSelected(action.position);
      if (action.decision) void submit(action.position, action.decision);
      else requestFocus(action.position);
    }}>
      <div className="section-heading queue-heading"><div><span className="eyebrow">02 / Review the evidence</span><h2 id="queue-heading">Your triage queue</h2><p>{session.demo ? 'Synthetic demo' : 'Imported report'} · {session.format} · {session.candidates} findings · {decided} human decisions</p></div><div className="queue-tools"><button disabled={!liveEnabled || saving} onClick={onLive}>Run live judge</button><button disabled={!canCloud || saving} onClick={onSaveSummary}>Save cloud summary</button><button className="primary" onClick={() => onExport('json')}>JSON ↓</button><button onClick={() => onExport('csv')}>CSV</button><button onClick={() => onExport('markdown')}>Markdown</button><button onClick={() => onExport('ignore')}>Ignore proposal</button><button className="text-button" onClick={onClear}>Clear session</button></div></div>
      {session.liveBudgetCap !== undefined && <div className="session-notice"><strong>Server budget ceiling: USD {session.liveBudgetCap.toPrecision(6)}</strong>{session.liveUsage ? <p>Latest {session.liveUsage.rows} accounting rows{session.liveUsage.possiblyTruncated ? ' (possibly truncated; totals are partial)' : ''}: estimates USD {session.liveUsage.estimatedUsd.toPrecision(6)}, settled actual USD {session.liveUsage.actualUsd.toPrecision(6)}, held estimates USD {session.liveUsage.heldUsd.toPrecision(6)}. The server enforces complete budget/day totals.</p> : <p>Accounting could not be safely read; totals are N/A. Ambiguous calls may retain reservations.</p>}</div>}
      <div className="session-notice" role="status">Worker terminated after parsing; raw references released. Memory disposal has not been measured. Cloud history requires explicit account storage consent; otherwise decisions stay local. Saved decisions replay only when finding id, masked content and keyed value tag all match. Re-import after reload to restore the guard.</div>
      {session.blocked > 0 && <div className="blocked-notice" role="status"><strong>{session.blocked} findings withheld for review.</strong> The guard blocked their material. They are excluded from the visible queue and export; review the original report locally. No dismissal was recorded for them.</div>}
      <p className="field-hint">Keyboard: J/K next/previous, R mark real, D approve dismissal, S skip. Changing a saved decision appends a new event. Notes are checked before saving.</p>
      <div className="band-counts" aria-label="Queue bands">
        {(['keep', 'review', 'dismiss'] as const).map((band) => <a className={`count-card ${band}`} href={`#band-${band}`} key={band}><span>{bandCopy[band].title}</span><strong>{counts[band]}</strong><small>{band === 'review' && session.blocked ? `+ ${session.blocked} withheld` : band === 'dismiss' ? 'Human approval required' : 'Queue placement'}</small></a>)}
      </div>
      {session.candidates === 0 && <p className="empty-report">The report parsed successfully and contains no findings.</p>}
      {(['keep', 'review'] as const).map((band) => <section id={`band-${band}`} className={`band band-${band}`} key={band} aria-labelledby={`heading-${band}`}><div className="band-heading"><h3 id={`heading-${band}`}>{bandCopy[band].title} <span>{counts[band]}</span></h3><p>{bandCopy[band].hint}</p></div><BandList band={band} items={ordered.filter((item) => visibleBand(item, session) === band)} selected={selected} saving={saving} {...actions} /></section>)}
      <details id="band-dismiss" className="band band-dismiss dismiss-band"><summary><span>Suggested dismissals <b>{counts.dismiss}</b></span><small>{bandCopy.dismiss.hint}</small></summary><BandList band="dismiss" items={ordered.filter((item) => visibleBand(item, session) === 'dismiss')} selected={selected} saving={saving} {...actions} /></details>
      <p className="privacy-footnote">Automated bands remain separate from your decisions. This is a dry run: no files are changed and no scanner ignore file is written.</p>
    </section>
  );
}
