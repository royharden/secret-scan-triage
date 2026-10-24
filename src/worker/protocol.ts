import type { ReportFormat } from '../core/ingest/index.ts';
import type { GuardSnapshot } from '../core/mask/guardSnapshot.ts';

export interface SelectedContextFile { path: string; file: File }

export type FormatChoice = 'auto' | ReportFormat;
export type ImportRequest = {
  kind: 'demo'; format: ReportFormat; projectSalt: Uint8Array; variant?: 'run1' | 'run2';
} | {
  kind: 'file'; file: File; format: FormatChoice; verificationEnabled: boolean; projectSalt: Uint8Array; selectedFiles?: SelectedContextFile[]; radius?: number;
};
// Fixed structural codes only. Never transport an Error, stack, error.message, filename or raw report fragment.
export type ImportFailure = 1 | 2 | 3 | 4 | 5 | 6;
export interface ImportComplete {
  kind: 'complete';
  snapshot: GuardSnapshot;
  rows: string[]; // Each row passed serializeSafe(..., 'ui_state') independently inside the worker.
  blocked: number;
  candidates: number;
  format: ReportFormat;
  demo: boolean;
  contextSkipped?: number;
}
export interface ImportFailureResponse {
  kind: 'error'; code: ImportFailure;
  // Structural location/count only. No report-controlled strings, identifiers or engine diagnostics.
  locationKind?: 0 | 1 | 2; // document, record, line
  locationIndex?: number;
  count?: number;
}
export type ImportResponse = ImportComplete | ImportFailureResponse;
