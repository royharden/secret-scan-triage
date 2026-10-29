import type { Session } from '../session.ts';
import { estimateAudit } from '../../core/audit/estimate.ts';
import committedReport from '../../../results/results.md?raw';
export function Results({ session }: { session: Session | null }) {
  const audit = session?.cohort && session.scope ? estimateAudit(session.cohort, session.events ?? [], session.scope) : null;
  const percent = (value: number | null) => value === null ? 'N/A' : `${(100 * value).toFixed(1)}%`;
  return <section className="setup-panel"><span className="eyebrow">Results / evidence</span><h2>Evaluation evidence</h2>
    <p>The committed scorer artifact below states its run status and provenance. The construction placeholder is not yet measured; scripted mock rows do not establish model performance or real-world accuracy.</p>
    <p>After dependency setup and validation are authorized, use <code>npm run eval</code>. Scripted mock rows are interface replay only. Thresholds remain untuned.</p>
    <details><summary>Committed scorer artifact</summary><pre style={{ overflowX: 'auto', whiteSpace: 'pre-wrap' }}>{committedReport}</pre></details>
    <h3>Current dismissal audit</h3>
    {audit ? <><p>Audited {audit.reviewed} reviewed of {audit.sampled} sampled; wrongly hidden {audit.wronglyHidden} of {audit.reviewed}.</p>
      <p>Response coverage {percent(audit.coverage)}. Wrongly-hidden rate {percent(audit.rate)}; Wilson 95% interval {audit.wilson95 ? `${percent(audit.wilson95.lower)} to ${percent(audit.wilson95.upper)}` : 'N/A'}.</p>
      <p>{audit.unreviewed} unreviewed or skipped. {audit.sampled === 0 ? 'No suggested dismissals to audit.' : 'Audit membership is disclosed here after labeling; it was hidden in the queue.'}</p></>
      : <p>Import a scan first. After reload, re-import before notes, exports, cloud upload or inference: the session leak guard is intentionally not persisted.</p>}
    <p>Human decisions and this audit do not change automated scorer recall or reduction.</p>
  </section>;
}
