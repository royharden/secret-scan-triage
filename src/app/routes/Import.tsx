import { useState } from 'react';
import { folderFiles, selectFolder } from '../../lib/folder.ts';
import type { SelectedContextFile } from '../../worker/protocol.ts';
import type { ReportFormat } from '../../core/ingest/index.ts';
import type { FormatChoice } from '../../worker/protocol.ts';

interface Props {
  busy: boolean;
  onDemo: (format: ReportFormat, variant: 'run1' | 'run2') => void;
  onFile: (file: File, format: FormatChoice, verificationEnabled: boolean, selectedFiles: SelectedContextFile[], radius: number) => void;
  onCancel: () => void;
}

export function Import({ busy, onDemo, onFile, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<FormatChoice>('auto');
  const [demoFormat, setDemoFormat] = useState<ReportFormat>('gitleaks');
  const [verification, setVerification] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<SelectedContextFile[]>([]);
  const [folderNotice, setFolderNotice] = useState('');
  const [radius, setRadius] = useState(3);
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
          <button className="primary" disabled={busy} onClick={() => onDemo(demoFormat, 'run1')}>Load demo scan <span aria-hidden="true">↗</span></button>
          <button className="secondary" disabled={busy} onClick={() => onDemo(demoFormat, 'run2')}>Load demo scan, run 2</button>
          <p className="field-hint">Run 2 changes context and replaces one value with the same mask. Saved decisions must be checked again.</p>
        </div>
        <form className="file-card" onSubmit={(e) => { e.preventDefault(); if (file) onFile(file, format, verification, selectedFiles, radius); }}>
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
          <fieldset disabled={busy} className="folder-controls"><legend>Optional local folder context</legend>
            <button type="button" className="secondary" onClick={() => { void selectFolder().then(files => { setSelectedFiles(files); setFolderNotice('Folder selected. Contents will be read only when you import.'); }, () => setFolderNotice('Folder picker unavailable or cancelled. Use the directory input below, especially in a preview iframe.')); }}>Choose folder</button>
            <label htmlFor="context-folder">Directory input fallback</label>
            <input id="context-folder" type="file" multiple ref={element => { element?.setAttribute('webkitdirectory', ''); }} onChange={event => {
              try { const files = folderFiles(event.target.files); setSelectedFiles(files); setFolderNotice('Folder selected. Re-import to apply context.'); }
              catch { setSelectedFiles([]); setFolderNotice('Too many files. Choose a smaller folder.'); }
            }} />
            <p className="field-hint">{selectedFiles.length} selected files. Files over 1 MB and content beyond the 50 MB folder budget are skipped. Report paths only look up selected files.</p>
            <label htmlFor="context-radius">Lines either side (maximum 3)</label>
            <input id="context-radius" type="number" min={0} max={3} value={radius} onChange={event => setRadius(Math.max(0, Math.min(3, Number(event.target.value) || 0)))} />
            <button type="button" className="text-button" onClick={() => { setSelectedFiles([]); setFolderNotice('Folder selection cleared. Re-import to use match-line context.'); }}>Clear folder</button>
            {folderNotice && <p role="status" className="field-hint">{folderNotice}</p>}
          </fieldset>
          <button type="submit" className="secondary" disabled={busy || !file}>Import and mask</button>
        </form>
      </div>
      {busy && <div className="loading-notice" role="status"><span className="spinner" aria-hidden="true" />Parsing and masking in a worker… <button className="text-button" onClick={onCancel}>Cancel import</button></div>}
      <p className="privacy-footnote">Raw report contents are read inside the worker. The page receives masked findings and a session-only hashed guard. Importing a new scan replaces this session.</p>
    </section>
  );
}
