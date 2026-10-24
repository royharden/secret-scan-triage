// Imported ONLY by parse.worker.ts (and tests). All raw report/File reads and demo generation stay in the worker.
import { checkSize, detectFormat, ImportError } from '../core/ingest/index.ts';
import type { ReportFormat } from '../core/ingest/index.ts';
import { runPipeline, pipelineConfig } from '../core/pipeline.ts';
import { generateSynthetic } from '../core/synth/index.ts';
import { createMockJudge } from '../core/providers/mock.ts';
import { buildMaskedView } from '../core/judge/views.ts';
import { loadThresholds, triage } from '../core/policy/decide.ts';
import { serializeSafe } from '../core/safe.ts';
import { snapshotGuard } from '../core/mask/guardSnapshot.ts';
import thresholdsJson from '../../config/thresholds.json' with { type: 'json' };
import type { QueueItem } from '../app/session.ts';
import type { ImportComplete, ImportFailure, ImportFailureResponse, ImportRequest } from './protocol.ts';

export const DEMO_SEED = 26024;

/** Return a structural status code only; even error names/messages/ids may match known material. */
export function failureCode(error: unknown): ImportFailure {
  if (!(error instanceof ImportError)) return 6;
  switch (error.code) {
    case 'too_large': return 1;
    case 'too_many': return 2;
    case 'unsupported': return 3;
    case 'ambiguous': return 4;
    case 'malformed': return 5;
    default: return 6;
  }
}

export function failureResponse(error: unknown): ImportFailureResponse {
  const response: ImportFailureResponse = { kind: 'error', code: failureCode(error) };
  if (!(error instanceof ImportError)) return response;
  if (Number.isSafeInteger(error.count) && (error.count as number) >= 0) response.count = error.count;
  if (error.location === 'document') response.locationKind = 0;
  else if (error.location) {
    const location = /^(record|line) (\d{1,9})$/.exec(error.location);
    if (location) { response.locationKind = location[1] === 'record' ? 1 : 2; response.locationIndex = Number(location[2]); }
  }
  return response;
}

export async function processImport(request: ImportRequest): Promise<ImportComplete> {
  if (!(request.projectSalt instanceof Uint8Array) || request.projectSalt.length !== 32) throw new Error('');
  let text: string;
  let files: Record<string, string> | undefined;
  let format: ReportFormat;
  if (request.kind === 'demo') {
    if (request.format !== 'gitleaks' && request.format !== 'trufflehog') throw new ImportError('unsupported');
    const demo = generateSynthetic({ seed: DEMO_SEED });
    text = request.format === 'gitleaks' ? demo.gitleaksJson : demo.trufflehogNdjson;
    files = demo.files;
    format = request.format;
    // labels/rawOracle never leave this worker. Only the selected report is processed in this run.
  } else if (request.kind === 'file') {
    // This check MUST precede File.text(). The page sends the File object, never its contents.
    checkSize(request.file.size);
    text = await request.file.text();
    if (request.format === 'auto') {
      const detected = detectFormat(text);
      if (detected === 'ambiguous' || detected === 'unsupported') throw new ImportError(detected);
      format = detected;
    } else if (request.format === 'gitleaks' || request.format === 'trufflehog') format = request.format;
    else throw new ImportError('unsupported');
  } else throw new ImportError('unsupported');

  const output = await runPipeline({
    text, format, files, projectSalt: request.projectSalt,
    verificationEnabled: request.kind === 'file' && request.verificationEnabled,
  });
  text = ''; files = undefined; // Release this scope's references; no claim of memory zeroisation.
  const config = pipelineConfig();
  const thresholds = loadThresholds(thresholdsJson);
  const judge = createMockJudge(DEMO_SEED);
  const rows: string[] = [];
  let blocked = 0;
  for (let position = 0; position < output.findings.length; position++) {
    const finding = output.findings[position];
    try {
      const result = await triage(finding, async (f) => {
        const view = buildMaskedView(f);
        if (view === null) throw new Error('');
        serializeSafe(view, 'judge_request', output.guard, f.id);
        return judge.judge(view); // Scripted local mock only; no network adapter is imported.
      }, thresholds, config.signals.highPrecisionRules);
      const item: QueueItem = {
        position, finding,
        decision: { band: result.band, stage: result.stage, reasons: result.reasons },
        judge: result.judge, human: 'pending',
      };
      rows.push(serializeSafe(item, 'ui_state', output.guard, finding.id));
    } catch { blocked++; } // Omit all unsafe material, including the id, rather than failing an ordinary whole import.
  }
  const snapshot = snapshotGuard(output.guard, config.prefixes);
  return {
    kind: 'complete', rows, snapshot, blocked,
    candidates: output.stats.candidates, format, demo: request.kind === 'demo',
  };
}
