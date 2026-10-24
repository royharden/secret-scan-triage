import type { Band, Finding } from '../finding.ts';
import type { RulingEvent } from '../rulings/types.ts';
import type { LeakGuard } from '../safe.ts';
import { serializeSafe } from '../safe.ts';

export interface ExportRow {
  finding: Finding;
  band: Band;
  /** Caller supplies only the latest event for the selected owner/project, never an older approval. */
  ruling?: RulingEvent;
}
/** serializeSafe is the single outbound path; decode its known JSON string for a plain text file. */
export function checkedExportText(text: string, guard: LeakGuard, findingId?: string): string {
  return JSON.parse(serializeSafe(text, 'export', guard, findingId)) as string;
}
export function ignoreEligibilityNote(row: ExportRow): string {
  if (row.ruling?.decision !== 'dismiss_approved') return '';
  if (row.finding.origin !== 'gitleaks') return 'Report only: trufflehog approval has no gitleaks ignore entry.';
  if (row.finding.fingerprint === undefined) return 'Report only: no original guard-passing fingerprint.';
  return 'Ignore proposal requires the current binding and a passing leak guard.';
}
export function csvCell(text: string): string {
  // Also cover whitespace before an operator, since spreadsheet importers vary in trimming behaviour.
  const neutral = /^[\t\r\n]/.test(text) || /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${neutral.replace(/"/g, '""')}"`;
}
export function exportCsv(rows: readonly ExportRow[], guard: LeakGuard): string {
  const lines = [['finding_id', 'scanner', 'path', 'line', 'masked_value', 'band', 'human_decision', 'reason_code', 'note', 'context', 'ignore_note'].map(csvCell).join(',')];
  for (const row of rows) {
    const f = row.finding;
    const cells = [f.id, f.scanner, f.path, String(f.line), f.maskedValue, row.band, row.ruling?.decision ?? '',
      row.ruling?.reasonCode ?? '', row.ruling?.note ?? '', f.maskedWindow.map((line) => `${line.lineId}: ${line.text}`).join('\n'), ignoreEligibilityNote(row)];
    // Guard original cell text too: escaping must not disguise a leaked value.
    serializeSafe(cells, 'export', guard, f.id);
    lines.push(cells.map(csvCell).join(','));
  }
  return checkedExportText(lines.join('\r\n') + '\r\n', guard);
}
