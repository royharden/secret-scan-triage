import { useState } from 'react';
import type { ReportFormat } from '../../core/ingest/index.ts';
import type { FormatChoice } from '../../worker/protocol.ts';

interface Props {
  busy: boolean;
  onDemo: (format: ReportFormat) => void;
  onFile: (file: File, format: FormatChoice, verificationEnabled: boolean) => void;
  onCancel: () => void;
}

export function Import({ busy, onDemo, onFile, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<FormatChoice>('auto');
  const [demoFormat, setDemoFormat] = useState<ReportFormat>('gitleaks');
  const [verification, setVerification] = useState(false);
  return (
    <section className="import-panel" aria-labelledby="import-heading">
      <div className="section-heading">
        <div><span className="eyebrow">01 / Start locally</span><h2 id="import-heading">Bring a scan. Keep the context.</h2></div>
        <span className="quiet-tag">No keys required</span>
      </div>
      <div className="import-grid">
        <div className="demo-card">
          <span className="mini-label">A safe place to start</span>
          <h3>Try the synthetic scan</h3>
          <p>Seeded examples include placeholders, verified findings and untrusted instructions. No real credentials.</p>
          <label htmlFor="demo-format">Demo scanner</label>
          <select id="demo-format" value={demoFormat} disabled={busy} onChange={(e) => setDemoFormat(e.target.value as ReportFormat)}>
            <option value="gitleaks">gitleaks JSON</option><option value="trufflehog">trufflehog JSON lines</option>
          </select>
          <button className="primary" disabled={busy} onClick={() => onDemo(demoFormat)}>Load demo scan <span aria-hidden="true">↗</span></button>
        </div>
        <form className="file-card" onSubmit={(e) => { e.preventDefault(); if (file) onFile(file, format, verification); }}>
          <h3>Import your scanner report</h3>
          <label htmlFor="report-file">Report file</label>
          <input id="report-file" type="file" accept=".json,.jsonl,.ndjson,application/json" disabled={busy}
            aria-describedby="report-limits" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p id="report-limits" className="field-hint">Up to 20,000,000 bytes and 20,000 findings. gitleaks arrays or trufflehog JSON lines. SARIF is unsupported.</p>
          <label htmlFor="report-format">Report format</label>
          <select id="report-format" value={format} disabled={busy} onChange={(e) => setFormat(e.target.value as FormatChoice)}>
            <option value="auto">Detect automatically</option><option value="gitleaks">gitleaks JSON array</option>
            <option value="trufflehog">trufflehog JSON lines</option>
          </select>
          <label className="checkbox-label" htmlFor="verification-enabled">
            <input id="verification-enabled" type="checkbox" checked={verification} disabled={busy} onChange={(e) => setVerification(e.target.checked)} />
            Verification was enabled for this scan
          </label>
          <p className="field-hint">Changes the displayed trufflehog label to “unverified”; policy still treats it as unknown.</p>
          <button type="submit" className="secondary" disabled={busy || !file}>Import and mask</button>
        </form>
      </div>
      {busy && <div className="loading-notice" role="status"><span className="spinner" aria-hidden="true" />Parsing and masking in a worker… <button className="text-button" onClick={onCancel}>Cancel import</button></div>}
      <p className="privacy-footnote">Raw report contents are read inside the worker. The page receives masked findings and a session-only hashed guard. Importing a new scan replaces this session.</p>
    </section>
  );
}
