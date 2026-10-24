import type { LeakGuard } from '../safe.ts';
import { serializeSafe } from '../safe.ts';
import { checkedExportText, ignoreEligibilityNote } from './csv.ts';
import type { ExportRow } from './csv.ts';

export function escapeMarkdown(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~\-])/g, '\\$1').replace(/\r\n|\r|\n/g, '<br>');
}
/** Plain escaped table, no raw HTML from report metadata and no active links from notes/paths. */
export function exportMarkdown(rows: readonly ExportRow[], guard: LeakGuard): string {
  const lines = ['# Masked triage report (dry run)', '', '| Finding | Scanner | Path | Line | Masked value | Band | Human decision | Reason | Note | Context | Ignore note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    const f = row.finding;
    const cells = [f.id, f.scanner, f.path, String(f.line), f.maskedValue, row.band, row.ruling?.decision ?? '',
      row.ruling?.reasonCode ?? '', row.ruling?.note ?? '', f.maskedWindow.map((line) => `${line.lineId}: ${line.text}`).join('\n'), ignoreEligibilityNote(row)];
    serializeSafe(cells, 'export', guard, f.id);
    lines.push(`| ${cells.map(escapeMarkdown).join(' | ')} |`);
  }
  return checkedExportText(lines.join('\n') + '\n', guard);
}
