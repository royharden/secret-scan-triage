import { useCallback, useEffect, useRef, useState } from 'react';
import { Import } from './routes/Import.tsx';
import { Queue } from './routes/Queue.tsx';
import { Setup } from './routes/Setup.tsx';
import { receiveItems, readQueueItem } from './session.ts';
import type { HumanDecision, Session } from './session.ts';
import { getProjectSalt } from '../lib/projectSalt.ts';
import type { Connection, LiveProvider } from './routes/Settings.tsx';
import { OFFLINE_CONSENT, mayUseCloud, mayUseInference } from '../lib/consent.ts';
import type { ConsentState } from '../lib/consent.ts';
import { requestLiveJudge } from '../lib/liveJudge.ts';
import { saveRunSummary } from '../lib/cloudRuns.ts';
import { beginRunLive, finishRunLive, recordRunLive } from '../lib/runAccounting.ts';
import { SupabaseRulingsStore } from '../core/rulings/supabase.ts';
import type { StructuralSupabaseClient } from '../core/rulings/supabase.ts';
import type { OwnerProject, RulingsStore } from '../core/rulings/types.ts';
import { createAuditCohort } from '../core/audit/sampler.ts';
import { buildMaskedView } from '../core/judge/views.ts';
import { failedResult } from '../core/judge/contract.ts';
import { decide as decidePolicy, needsJudge } from '../core/policy/decide.ts';
import { loadThresholds } from '../core/policy/thresholds.ts';
import thresholdsJson from '../../config/thresholds.json' with { type: 'json' };
import highPrecisionJson from '../../config/high-precision-rules.json' with { type: 'json' };
import { Results } from './routes/Results.tsx';
import { LOCAL_SCOPE, mapCloudFindingIds, prepareJourney, rulingDraft, humanDecision } from './journey.ts';
import type { RulingEvent } from '../core/rulings/types.ts';
import { IndexedDbAuditStore } from '../core/audit/idb.ts';
import { IndexedDbRulingsStore } from '../core/rulings/idb.ts';
import { exportCsv } from '../core/export/csv.ts';
import { exportMarkdown } from '../core/export/markdown.ts';
import { exportGitleaksIgnore } from '../core/export/gitleaksignore.ts';
import { serializeSafe } from '../core/safe.ts';
import type { SelectedContextFile } from '../worker/protocol.ts';
import { NOT_READY_GUARD } from '../core/safe.ts';
import type { LeakGuard } from '../core/safe.ts';
import { restoreGuard } from '../core/mask/guardSnapshot.ts';
import { loadPrefixConfig, prefixStrings } from '../core/mask/mask.ts';
import { MAX_FINDINGS } from '../core/ingest/limits.ts';
import type { ReportFormat } from '../core/ingest/index.ts';
import { exportMaskedJson } from '../core/export/json.ts';
import type { FormatChoice, ImportComplete, ImportFailure, ImportRequest } from '../worker/protocol.ts';
import prefixesJson from '../../config/prefixes.json' with { type: 'json' };

const liveEnabled = import.meta.env.VITE_LIVE_JUDGE_ENABLED === 'true';
const browserThresholds = loadThresholds(thresholdsJson);
const highPrecisionRules = (highPrecisionJson as { rules?: string[] }).rules ?? [];
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

type Start = { kind: 'demo'; format: ReportFormat; variant?: 'run1' | 'run2' } | { kind: 'file'; file: File; format: FormatChoice; verificationEnabled: boolean; selectedFiles?: SelectedContextFile[]; radius?: number };
type DownloadFormat = 'json' | 'csv' | 'markdown' | 'ignore';

export function App() {
  const [page, setPage] = useState<'review' | 'setup' | 'results'>('review');
  const [session, setSession] = useState<Session | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const connectionRef = useRef<Connection | null>(null);
  const [consent, setConsent] = useState<ConsentState>({ ...OFFLINE_CONSENT });
  const consentRef = useRef<ConsentState>({ ...OFFLINE_CONSENT });
  const [provider, setProvider] = useState<LiveProvider>('anthropic');
  const providerRef = useRef<LiveProvider>('anthropic');
  const [living, setLiving] = useState(false);
  const cloudStore = useRef<{ client: Connection['client']; store: SupabaseRulingsStore } | null>(null);
  const [saving, setSaving] = useState(false);
  const store = useRef(new IndexedDbRulingsStore());
  const auditStore = useRef(new IndexedDbAuditStore());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [exportCounts, setExportCounts] = useState<{ exported: number; blocked: number } | null>(null);
  const guard = useRef<LeakGuard>(NOT_READY_GUARD);
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);

  useEffect(() => () => { generation.current++; worker.current?.terminate(); worker.current = null; guard.current = NOT_READY_GUARD; store.current.close(); auditStore.current.close(); cloudStore.current?.store.close(); }, []);

  const stop = useCallback(() => {
    generation.current++; worker.current?.terminate(); worker.current = null;
    guard.current = NOT_READY_GUARD; setBusy(false); setLiving(false);
  }, []);
  const clear = useCallback(() => { stop(); setSession(null); setNotice(''); setExportCounts(null); }, [stop]);

  const onConnection = useCallback((next: Connection) => {
    const previous = connectionRef.current;
    connectionRef.current = next; setConnection(next);
    if ((previous?.userId ?? null) !== next.userId || (previous?.userId && previous.client !== next.client)) {
      consentRef.current = { ...OFFLINE_CONSENT }; setConsent({ ...OFFLINE_CONSENT }); clear();
    }
  }, [clear]);
  function changeConsent(next: ConsentState) {
    if (next.cloudStorage !== consentRef.current.cloudStorage) { clear(); setNotice('Ruling store changed. Re-import before notes, exports, cloud uploads or inference.'); }
    consentRef.current = { ...next }; setConsent({ ...next });
  }
  function changeProvider(next: LiveProvider) {
    providerRef.current = next; setProvider(next);
    consentRef.current = { ...consentRef.current, liveInference: false }; setConsent({ ...consentRef.current });
    setNotice('Provider changed. Review its notice and explicitly enable inference again.');
  }
  function storeFor(scope: OwnerProject): RulingsStore {
    if (scope.ownerId === LOCAL_SCOPE.ownerId) return store.current;
    const current = connectionRef.current;
    if (!current || current.userId !== scope.ownerId || !mayUseCloud(consentRef.current, current.userId, guard.current.ready)) throw new Error('');
    if (!cloudStore.current || cloudStore.current.client !== current.client) {
      cloudStore.current = { client: current.client, store: new SupabaseRulingsStore(current.client as unknown as StructuralSupabaseClient,
        () => ({ userId: connectionRef.current?.userId ?? null, cloudStorage: consentRef.current.cloudStorage && guard.current.ready })) };
    }
    return cloudStore.current.store;
  }

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
    active.onmessage = async (event: MessageEvent<unknown>) => {
      if (generation.current !== run) { active.terminate(); return; }
      finish(); // Raw worker lifetime ends before any payload is handled by the page.
      const data = event.data;
      try {
        if (!isComplete(data)) {
          setNotice(failureNotice(data)); return;
        }
        setBusy(true);
        const restored = restoreGuard(data.snapshot, configuredPrefixes);
        const received = receiveItems(data.rows, restored);
        guard.current = restored;
        const currentConnection = connectionRef.current;
        const scope = mayUseCloud(consentRef.current, currentConnection?.userId ?? null, restored.ready) && currentConnection?.userId ? { ownerId: currentConnection.userId, projectKey: LOCAL_SCOPE.projectKey } : LOCAL_SCOPE;
        let events: RulingEvent[];
        let storageUnavailable = false;
        try { events = await storeFor(scope).list(scope); }
        catch { events = []; storageUnavailable = true; }
        const mapped = await mapCloudFindingIds({ items: received.items, blocked: data.blocked + received.blocked,
          candidates: data.candidates, format: data.format, demo: data.demo, thresholdsSource: browserThresholds.source }, scope, salt, restored);
        const prepared = await prepareJourney(mapped, events, scope, restored);
        if (generation.current !== run) return;
        if (!prepared.cohort) throw new Error('');
        await auditStore.current.append(scope, prepared.cohort, restored);
        if (generation.current !== run) return;
        guard.current = restored;
        setSession(prepared);
        if (storageUnavailable) setNotice('Saved rulings could not be read. No replay was claimed; new saves will report any storage failure.');
        else if (data.contextSkipped) setNotice(`${data.contextSkipped} selected context files were skipped by size, path or folder-budget limits.`);
      } catch { if (generation.current === run) { guard.current = NOT_READY_GUARD; setNotice(failures[6]); } }
      finally { if (generation.current === run) setBusy(false); }
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

  async function decide(position: number, human: HumanDecision, note = '') {
    if (!session || saving || living || !guard.current.ready) return;
    const item = session.items.find(row => row.position === position);
    if (!item) return;
    const run = generation.current;
    setSaving(true); setNotice(''); setExportCounts(null);
    try {
      const event = await storeFor(session.scope ?? LOCAL_SCOPE).append(rulingDraft(session, item, human, note), guard.current);
      const updated = readQueueItem(serializeSafe({ ...item, ruling: event, human: humanDecision(event), replayReason: undefined }, 'ui_state', guard.current), guard.current);
      if (generation.current === run) {
        setSession(current => current ? { ...current, items: current.items.map(row => row.position === position ? updated : row), events: [...(current.events ?? []), event] } : null);
        setNotice(`Decision saved ${session.scope?.ownerId === 'offline' ? 'locally' : 'in your account'}. Changing it appends a new event; earlier history is preserved.`);
      }
    } catch { if (generation.current === run) setNotice('Decision was not confirmed saved. Storage or the leak guard refused it. Shorten the note or re-import; no persistence success is claimed.'); }
    finally { setSaving(false); }
  }
  function download(format: DownloadFormat) {
    if (!session || !guard.current.ready) return;
    setNotice(''); setExportCounts(null);
    try {
      let text: string;
      let mime = 'text/plain;charset=utf-8';
      let filename = 'proposed.gitleaksignore';
      const rows = session.items.map(item => ({ finding: item.finding, band: item.decision.band, ruling: item.ruling }));
      if (format === 'json') {
        const hasLive = (session.liveAccounting?.actions ?? 0) > 0 || session.items.some(item => item.judge && item.judge.provider !== 'mock');
        const hasMock = session.items.some(item => item.judge?.provider === 'mock');
        const result = exportMaskedJson(session.items, guard.current, session.blocked, { source: hasLive ? hasMock ? 'mixed' : 'live' : 'scripted-mock', thresholds: browserThresholds.source, rulingsPersistence: session.scope?.ownerId === 'offline' ? 'indexeddb-append-only' : 'supabase-append-only' });
        text = result.json; mime = 'application/json;charset=utf-8'; filename = 'masked-triage.json';
        setExportCounts({ exported: result.exported, blocked: result.blocked });
      } else if (format === 'csv') { text = exportCsv(rows, guard.current); mime = 'text/csv;charset=utf-8'; filename = 'masked-triage.csv'; }
      else if (format === 'markdown') { text = exportMarkdown(rows, guard.current); filename = 'masked-triage.md'; }
      else {
        if (!session.scope) throw new Error('');
        const bindings = new Map(session.items.filter(item => item.binding).map(item => [item.finding.id, item.binding!]));
        const result = exportGitleaksIgnore(rows, bindings, session.scope, guard.current);
        text = result.text;
        setNotice(`Ignore proposal: ${result.included} approved current gitleaks fingerprints; ${result.excluded} excluded. Download only; no repository was changed.`);
      }
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setNotice('The guard blocked the download. Re-import before exporting; unsafe material was not exported.'); }
  }

  async function runLive() {
    const current = connectionRef.current;
    if (!session || !current?.userId || living || saving || !mayUseInference(consentRef.current, current.userId, guard.current.ready, liveEnabled)) return;
    const run = generation.current; const activeGuard = guard.current; const selectedProvider = providerRef.current;
    const eligible = session.items.filter(item => needsJudge(item.finding));
    if (!eligible.length) { setNotice('No unresolved findings are eligible for a judge. Deterministic decisions remain unchanged.'); return; }
    const views = eligible.map(item => { const view = buildMaskedView(item.finding); return view ? { ...view, findingId: `candidate-${item.position}` } : null; });
    if (views.some(view => view === null)) { setNotice('A masked view exceeds the safe request bound. Re-import with less context.'); return; }
    const authorized = () => generation.current === run && guard.current === activeGuard && connectionRef.current?.userId === current.userId && providerRef.current === selectedProvider && mayUseInference(consentRef.current, current.userId, activeGuard.ready, liveEnabled);
    setLiving(true); setNotice('');
    let runAccounting = beginRunLive(session.liveAccounting);
    const retainAccounting = () => {
      if (generation.current === run) setSession(latest => latest?.runId === session.runId ? { ...latest, liveAccounting: runAccounting } : latest);
    };
    retainAccounting(); // Latch possible live work before awaiting; revoked/blocked/caught paths cannot look like mock/zero spend.
    try {
      const result = await requestLiveJudge({ client: current.client, userId: current.userId, consent: consentRef.current, enabled: liveEnabled, provider: selectedProvider, views: views.filter(view => view !== null), guard: activeGuard, authorized });
      runAccounting = recordRunLive(runAccounting, result.results, result.failed, eligible.length);
      retainAccounting(); // Trusted numeric lower bounds survive later guard/cohort/consent failures; pending is still latched.
      if (!authorized()) return;
      const byPosition = new Map(eligible.map((item, index) => [item.position, result.results[index]]));
      let blocked = session.blocked;
      const items = session.items.flatMap(item => {
        if (!byPosition.has(item.position)) return [item];
        const received = byPosition.get(item.position);
        const judge = received ?? { ...failedResult(selectedProvider, 'unavailable', 'provider_error'), usage_unknown: true };
        const decision = decidePolicy(item.finding, judge, browserThresholds, highPrecisionRules);
        try { return [readQueueItem(serializeSafe({ ...item, judge, decision }, 'ui_state', activeGuard), activeGuard)]; }
        catch { blocked++; return []; }
      });
      const cohort = createAuditCohort(`${session.runId}:live:${globalThis.crypto.randomUUID()}`, items.filter(item => item.decision.band === 'dismiss' && item.binding).map(item => item.binding!), 26024);
      await auditStore.current.append(session.scope ?? LOCAL_SCOPE, cohort, activeGuard);
      if (!authorized()) return;
      runAccounting = finishRunLive(runAccounting, true);
      setSession(latest => latest?.runId === session.runId ? { ...latest, items, blocked, cohort,
        liveBudgetCap: result.budget.capUsd, liveUsage: result.usage, liveAccounting: runAccounting } : latest);
      setNotice(`Live processing returned ${result.results.length - result.failed} results; ${result.failed} lacked a safe reply and were routed to review. Server reservations remain authoritative, including ambiguous calls.`);
    } catch {
      runAccounting = finishRunLive(runAccounting, false); retainAccounting();
      if (generation.current === run) setNotice('Live inference could not complete. Check sign-in, consent, configured provider/model/prices and server caps. Any ambiguous attempt may retain its reservation.');
    }
    finally { if (generation.current === run) setLiving(false); }
  }
  async function uploadSummary() {
    const current = connectionRef.current;
    if (!session || !current?.userId) return;
    const authorized = () => mayUseCloud(consentRef.current, connectionRef.current?.userId ?? null, guard.current.ready) && connectionRef.current?.userId === session.scope?.ownerId;
    try { await saveRunSummary(current.client, current.userId, consentRef.current, session, guard.current, authorized); setNotice('Masked run summary saved in your account. No source paths or lines were uploaded.'); }
    catch { setNotice('Cloud summary was not confirmed saved. Check cloud consent, re-import and account configuration.'); }
  }

  return <>
    <a className="skip-link" href="#main">Skip to main content</a>
    <header className="site-header"><a className="brand" href="#main" onClick={() => setPage('review')}><span className="brand-mark" aria-hidden="true">S/</span><span>secret-scan<span className="brand-sub">TRIAGE WORKSPACE</span></span></a><nav aria-label="Main navigation"><button className={page === 'review' ? 'nav-active' : ''} onClick={() => setPage('review')}>Local review</button><button className={page === 'setup' ? 'nav-active' : ''} onClick={() => setPage('setup')}>Setup</button><button className={page === 'results' ? 'nav-active' : ''} onClick={() => setPage('results')}>Results</button></nav></header>
    <main id="main">
      <div className="local-banner"><span className="status-dot" aria-hidden="true" /><strong>{consent.cloudStorage || consent.liveInference ? 'Connected choices enabled' : 'Local demo mode'}</strong><span>{consent.cloudStorage || consent.liveInference ? 'Only explicitly enabled actions may send guarded data.' : 'No report data leaves this browser.'}</span><span className="mode-tag">{session?.items.some(item => item.judge && item.judge.provider !== 'mock') ? 'Contains live provider results' : 'Scripted mock · no LLM'}</span></div>
      <section className="hero"><span className="eyebrow">LESS NOISE. SAME CAUTION.</span><h1>Find the signal.<br /><em>Keep the secrets local.</em></h1><p>Turn a scanner report into a reviewable queue. Masked context, explicit evidence, and a human decision for every dismissal.</p><div className="hero-meta"><span>01 Import & mask</span><span aria-hidden="true">→</span><span>02 Review evidence</span><span aria-hidden="true">→</span><span>03 Export a dry run</span></div></section>
      <div className="threshold-banner"><strong>Thresholds: {browserThresholds.source}</strong><span>Judge dismissal {browserThresholds.judge_dismiss_enabled ? 'enabled by dev artifact' : 'disabled'}. Provider/model provenance is shown on each scored row. Construction has not been run.</span></div>
      {notice && <div className="error-notice" role="alert">{notice}</div>}
      {exportCounts && <div className="session-notice" role="status">Download prepared: {exportCounts.exported} masked findings; {exportCounts.blocked} withheld for review.</div>}
      {page === 'setup' ? <Setup onBack={() => setPage('review')} onConnection={onConnection} consent={consent} onConsent={changeConsent} provider={provider} onProvider={changeProvider} liveEnabled={liveEnabled} /> : page === 'results' ? <Results session={session} /> : <><Import busy={busy} onDemo={(format, variant) => void start({ kind: 'demo', format, variant })} onFile={(file, format, verificationEnabled, selectedFiles, radius) => void start({ kind: 'file', file, format, verificationEnabled, selectedFiles, radius })} onCancel={() => { stop(); setNotice('Import cancelled. Load a scan to start a new session.'); }} />{session ? <Queue key={session.runId} session={session} saving={saving || living} onLive={() => { void runLive(); }} liveEnabled={mayUseInference(consent, connection?.userId ?? null, guard.current.ready, liveEnabled)} onSaveSummary={() => { void uploadSummary(); }} canCloud={mayUseCloud(consent, connection?.userId ?? null, guard.current.ready) && session.scope?.ownerId === connection?.userId} checkNote={note => { try { serializeSafe(note, 'note', guard.current); return true; } catch { return false; } }} onDecision={decide} onExport={download} onClear={clear} /> : !busy && <section className="empty-state"><span aria-hidden="true" className="empty-symbol">[ * ]</span><h2>Your next review starts here.</h2><p>Load the demo or import a scanner report to see keep, review and suggested-dismissal bands.</p></section>}</>}
    </main>
    <footer><span>Secret-scan triage / construction preview</span><span>Append-only local rulings · masked exports · results not yet measured</span></footer>
  </>;
}
