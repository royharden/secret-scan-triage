import { useEffect, useRef, useState } from 'react';
import { Import } from './routes/Import.tsx';
import { Queue } from './routes/Queue.tsx';
import { Setup } from './routes/Setup.tsx';
import { receiveItems, updateDecision } from './session.ts';
import type { HumanDecision, Session } from './session.ts';
import { getProjectSalt } from '../lib/projectSalt.ts';
import { NOT_READY_GUARD } from '../core/safe.ts';
import type { LeakGuard } from '../core/safe.ts';
import { restoreGuard } from '../core/mask/guardSnapshot.ts';
import { loadPrefixConfig, prefixStrings } from '../core/mask/mask.ts';
import { MAX_FINDINGS } from '../core/ingest/limits.ts';
import type { ReportFormat } from '../core/ingest/index.ts';
import { exportMaskedJson } from '../core/export/json.ts';
import type { FormatChoice, ImportComplete, ImportFailure, ImportRequest } from '../worker/protocol.ts';
import prefixesJson from '../../config/prefixes.json' with { type: 'json' };

const configuredPrefixes = prefixStrings(loadPrefixConfig(prefixesJson));
const failures: Record<ImportFailure, string> = {
  1: 'The report exceeds the 20,000,000-byte limit. Choose a smaller report.',
  2: 'Import stopped at the 20,000-finding limit. Split the report and try again.',
  3: 'Unsupported format. Choose a gitleaks JSON array or trufflehog JSON-lines report. SARIF is unsupported.',
  4: 'The format is ambiguous. Choose gitleaks or trufflehog explicitly and import again.',
  5: 'The report contains malformed records. Check its structure locally and try again. Report fragments are never displayed.',
  6: 'Import could not finish safely. Try a smaller supported report or load the demo scan.',
};

function failureNotice(value: unknown): string {
  if (!value || typeof value !== 'object') return failures[6];
  const v = value as Record<string, unknown>;
  if (v.kind !== 'error' || typeof v.code !== 'number' || ![1, 2, 3, 4, 5, 6].includes(v.code)) return failures[6];
  let message = failures[v.code as ImportFailure];
  const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (v.code === 5 && validCount(v.count)) message += ` Malformed record count: ${v.count}.`;
  if (v.code === 5 && (v.locationKind === 1 || v.locationKind === 2) && validCount(v.locationIndex) && v.locationIndex <= 999_999_999) {
    message += ` First location: ${v.locationKind === 1 ? 'record' : 'line'} ${v.locationIndex}.`;
  }
  return message;
}

function isComplete(value: unknown): value is ImportComplete {
  if (!value || typeof value !== 'object') return false;
  const v = value as ImportComplete;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_FINDINGS;
  return v.kind === 'complete' && Array.isArray(v.rows) && v.rows.length <= MAX_FINDINGS && v.rows.every((row) => typeof row === 'string')
    && count(v.blocked) && count(v.candidates) && v.rows.length + v.blocked === v.candidates
    && ['gitleaks', 'trufflehog'].includes(v.format) && typeof v.demo === 'boolean';
}

type Start = { kind: 'demo'; format: ReportFormat } | { kind: 'file'; file: File; format: FormatChoice; verificationEnabled: boolean };

export function App() {
  const [page, setPage] = useState<'review' | 'setup'>('review');
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [exportCounts, setExportCounts] = useState<{ exported: number; blocked: number } | null>(null);
  const guard = useRef<LeakGuard>(NOT_READY_GUARD);
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);

  useEffect(() => () => { generation.current++; worker.current?.terminate(); worker.current = null; guard.current = NOT_READY_GUARD; }, []);

  function stop() {
    generation.current++; worker.current?.terminate(); worker.current = null;
    guard.current = NOT_READY_GUARD; setBusy(false);
  }
  function clear() { stop(); setSession(null); setNotice(''); setExportCounts(null); }

  async function start(input: Start) {
    clear(); setBusy(true);
    const run = generation.current;
    let salt: Uint8Array;
    try { salt = await getProjectSalt(); }
    catch {
      if (generation.current === run) { setBusy(false); setNotice('Browser storage is unavailable or the local identity salt is invalid. Enable IndexedDB storage, then retry. No report was read.'); }
      return;
    }
    if (generation.current !== run) return;
    let active: Worker;
    try { active = new Worker(new URL('../worker/parse.worker.ts', import.meta.url), { type: 'module' }); }
    catch { setBusy(false); setNotice(failures[6]); return; }
    worker.current = active;
    const finish = () => { active.terminate(); if (worker.current === active) worker.current = null; setBusy(false); };
    active.onmessage = (event: MessageEvent<unknown>) => {
      if (generation.current !== run) { active.terminate(); return; }
      finish(); // Raw worker lifetime ends before any payload is handled by the page.
      const data = event.data;
      try {
        if (!isComplete(data)) {
          setNotice(failureNotice(data)); return;
        }
        const restored = restoreGuard(data.snapshot, configuredPrefixes);
        const received = receiveItems(data.rows, restored);
        guard.current = restored;
        setSession({ items: received.items, blocked: data.blocked + received.blocked, candidates: data.candidates, format: data.format, demo: data.demo });
      } catch { guard.current = NOT_READY_GUARD; setNotice(failures[6]); }
    };
    active.onerror = (event) => {
      event.preventDefault(); // Never display or forward the engine's potentially data-bearing message.
      if (generation.current === run) { finish(); setNotice(failures[6]); }
    };
    active.onmessageerror = () => { if (generation.current === run) { finish(); setNotice(failures[6]); } };
    const request: ImportRequest = { ...input, projectSalt: salt };
    try { active.postMessage(request); }
    catch { finish(); setNotice(failures[6]); }
  }

  function decide(position: number, human: HumanDecision) {
    setExportCounts(null);
    setSession((current) => current ? updateDecision(current, position, human, guard.current) : null);
  }
  function download() {
    if (!session) return;
    setNotice(''); setExportCounts(null);
    try {
      const result = exportMaskedJson(session.items, guard.current, session.blocked);
      const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'masked-triage.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportCounts({ exported: result.exported, blocked: result.blocked });
    } catch { setNotice('The guard blocked the download. No unsafe report was exported. Re-import the report before trying again; review withheld findings locally.'); }
  }

  return <>
    <a className="skip-link" href="#main">Skip to main content</a>
    <header className="site-header"><a className="brand" href="#main" onClick={() => setPage('review')}><span className="brand-mark" aria-hidden="true">S/</span><span>secret-scan<span className="brand-sub">TRIAGE WORKSPACE</span></span></a><nav aria-label="Main navigation"><button className={page === 'review' ? 'nav-active' : ''} onClick={() => setPage('review')}>Local review</button><button className={page === 'setup' ? 'nav-active' : ''} onClick={() => setPage('setup')}>Setup</button></nav></header>
    <main id="main">
      <div className="local-banner"><span className="status-dot" aria-hidden="true" /><strong>Local demo mode</strong><span>Nothing leaves this browser.</span><span className="mode-tag">Scripted mock · no LLM</span></div>
      <section className="hero"><span className="eyebrow">LESS NOISE. SAME CAUTION.</span><h1>Find the signal.<br /><em>Keep the secrets local.</em></h1><p>Turn a scanner report into a reviewable queue. Masked context, explicit evidence, and a human decision for every dismissal.</p><div className="hero-meta"><span>01 Import & mask</span><span aria-hidden="true">→</span><span>02 Review evidence</span><span aria-hidden="true">→</span><span>03 Export a dry run</span></div></section>
      <div className="threshold-banner"><strong>Untuned thresholds</strong><span>Defaults are unmeasured. Judge-based dismissal is disabled. Scores come from a scripted mock, not an LLM.</span></div>
      {notice && <div className="error-notice" role="alert">{notice}</div>}
      {exportCounts && <div className="session-notice" role="status">Download prepared: {exportCounts.exported} masked findings; {exportCounts.blocked} withheld for review.</div>}
      {page === 'setup' ? <Setup onBack={() => setPage('review')} /> : <><Import busy={busy} onDemo={(format) => void start({ kind: 'demo', format })} onFile={(file, format, verificationEnabled) => void start({ kind: 'file', file, format, verificationEnabled })} onCancel={() => { stop(); setNotice('Import cancelled. Load a scan to start a new session.'); }} />{session ? <Queue session={session} onDecision={decide} onExport={download} onClear={clear} /> : !busy && <section className="empty-state"><span aria-hidden="true" className="empty-symbol">[ * ]</span><h2>Your next review starts here.</h2><p>Load the demo or import a scanner report to see keep, review and suggested-dismissal bands.</p></section>}</>}
    </main>
    <footer><span>Secret-scan triage / construction preview</span><span>Local decisions · masked exports · results not yet measured</span></footer>
  </>;
}
