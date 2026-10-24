import { useState } from 'react';
import type { Band } from '../../core/finding.ts';
import type { HumanDecision, QueueItem, Session } from '../session.ts';
import { bandCounts } from '../session.ts';

interface Props {
  session: Session;
  onDecision: (position: number, decision: HumanDecision) => void;
  onExport: () => void;
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

function FindingCard({ item, onDecision }: { item: QueueItem; onDecision: Props['onDecision'] }) {
  const f = item.finding;
  const titleId = `finding-${item.position}`;
  return (
    <article className={`finding-card ${item.human !== 'pending' ? 'decided' : ''}`} aria-labelledby={titleId}>
      <div className="finding-topline"><span className="scanner-label">{f.scanner}</span><span className={`verification ${f.verified === 'verified' ? 'verified' : ''}`}>{f.verifiedLabel}</span><span className="human-status">{humanLabels[item.human]}</span></div>
      <h4 id={titleId}><code>{f.ruleId}</code></h4>
      <p className="finding-path"><code>{f.path || '(path unavailable)'}</code><span>line {f.line}</span></p>
      <div className="masked-value"><span className="mini-label">Masked value</span><code>{f.maskedValue}</code><small>{f.length} characters · {f.charClass}</small></div>
      {f.flags.injection && <p className="flag">Untrusted instructions detected near this finding. They are never evidence.</p>}
      {f.flags.contextMismatch && <p className="flag">Context mismatch: using the scanner match line.</p>}
      {f.flags.unmaskableContext && <p className="flag">A context line was withheld because it could not be safely masked.</p>}
      <ul className="decision-reasons">{item.decision.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
      <div className="judge-line">{item.judge ? <><span className="mini-label">Scripted mock judge</span><span>p_real {item.judge.p_real.toFixed(2)} · {item.judge.reason_code}</span></> : <span>Deterministic decision · judge not requested</span>}</div>
      <details className="evidence">
        <summary>Context & signal evidence <span>({f.signals.length} signals)</span></summary>
        {f.maskedWindow.length > 0 ? <pre>{f.maskedWindow.map((line) => <span key={line.lineId}><b>{line.lineId}</b> {line.text}{'\n'}</span>)}</pre> : <p>Context unavailable or withheld.</p>}
        {f.signals.length > 0 ? <ul>{f.signals.map((signal, i) => <li key={`${signal.id}-${i}`}><strong>{signal.id}</strong> {signal.name} · {signal.direction} / {signal.strength} · {signal.evidence.lineId}{typeof signal.evidence.start === 'number' && typeof signal.evidence.end === 'number' ? ` [${signal.evidence.start}, ${signal.evidence.end})` : ''}</li>)}</ul> : <p>No deterministic signals on this span.</p>}
      </details>
      <div className="finding-actions" aria-label={`Decision for finding ${item.position + 1}`}>
        <button className="action-real" aria-pressed={item.human === 'real'} onClick={() => onDecision(item.position, 'real')}>Mark real</button>
        <button aria-pressed={item.human === 'approved_dismissal'} onClick={() => onDecision(item.position, 'approved_dismissal')}>Approve dismissal</button>
        <button className="text-button" aria-pressed={item.human === 'skipped'} onClick={() => onDecision(item.position, 'skipped')}>Skip</button>
      </div>
    </article>
  );
}

function BandList({ band, items, onDecision }: { band: Band; items: QueueItem[]; onDecision: Props['onDecision'] }) {
  const [visible, setVisible] = useState(30);
  return <>
    {items.length === 0 ? <p className="band-empty">No findings in this band.</p> : <div className="finding-list">{items.slice(0, visible).map((item) => <FindingCard key={item.position} item={item} onDecision={onDecision} />)}</div>}
    {items.length > visible && <button className="secondary show-more" onClick={() => setVisible((n) => n + 30)}>Show 30 more {bandCopy[band].title.toLowerCase()} findings ({items.length - visible} remaining)</button>}
  </>;
}

export function Queue({ session, onDecision, onExport, onClear }: Props) {
  const counts = bandCounts(session);
  const decided = session.items.filter((item) => item.human !== 'pending').length;
  return (
    <section className="queue-panel" aria-labelledby="queue-heading">
      <div className="section-heading queue-heading"><div><span className="eyebrow">02 / Review the evidence</span><h2 id="queue-heading">Your triage queue</h2><p>{session.demo ? 'Synthetic demo' : 'Imported report'} · {session.format} · {session.candidates} findings · {decided} human decisions</p></div><div className="queue-tools"><button className="primary" onClick={onExport}>Download masked JSON <span aria-hidden="true">↓</span></button><button className="text-button" onClick={onClear}>Clear session</button></div></div>
      <div className="session-notice" role="status">Worker terminated after parsing; raw references released. Memory disposal has not been measured. Decisions last until you clear, re-import or reload.</div>
      {session.blocked > 0 && <div className="blocked-notice" role="status"><strong>{session.blocked} findings withheld for review.</strong> The guard blocked their material. They are excluded from the visible queue and export; review the original report locally. No dismissal was recorded for them.</div>}
      <div className="band-counts" aria-label="Automated bands">
        {(['keep', 'review', 'dismiss'] as const).map((band) => <a className={`count-card ${band}`} href={`#band-${band}`} key={band}><span>{bandCopy[band].title}</span><strong>{counts[band]}</strong><small>{band === 'review' && session.blocked ? `+ ${session.blocked} withheld` : band === 'dismiss' ? 'Human approval required' : 'Automated band'}</small></a>)}
      </div>
      {session.candidates === 0 && <p className="empty-report">The report parsed successfully and contains no findings.</p>}
      {(['keep', 'review'] as const).map((band) => <section id={`band-${band}`} className={`band band-${band}`} key={band} aria-labelledby={`heading-${band}`}><div className="band-heading"><h3 id={`heading-${band}`}>{bandCopy[band].title} <span>{counts[band]}</span></h3><p>{bandCopy[band].hint}</p></div><BandList band={band} items={session.items.filter((item) => item.decision.band === band)} onDecision={onDecision} /></section>)}
      <details id="band-dismiss" className="band band-dismiss dismiss-band"><summary><span>Suggested dismissals <b>{counts.dismiss}</b></span><small>{bandCopy.dismiss.hint}</small></summary><BandList band="dismiss" items={session.items.filter((item) => item.decision.band === 'dismiss')} onDecision={onDecision} /></details>
      <p className="privacy-footnote">Automated bands remain separate from your decisions. This is a dry run: no files are changed and no scanner ignore file is written.</p>
    </section>
  );
}
