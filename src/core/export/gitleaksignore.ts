import { sameBinding } from '../rulings/binding.ts';
import { sameScope } from '../rulings/types.ts';
import type { OwnerProject, RulingBinding } from '../rulings/types.ts';
import type { LeakGuard } from '../safe.ts';
import { LeakGuardError, serializeSafe } from '../safe.ts';
import { checkedExportText } from './csv.ts';
import type { ExportRow } from './csv.ts';

export interface GitleaksIgnoreExport { text: string; included: number; excluded: number }
/** Browser download proposal only: never writes to a repository. Fingerprints are copied verbatim. */
export function exportGitleaksIgnore(
  rows: readonly ExportRow[], bindings: ReadonlyMap<string, RulingBinding>, scope: OwnerProject, guard: LeakGuard,
): GitleaksIgnoreExport {
  serializeSafe([], 'export', guard); // A reload cannot quietly return an unchecked empty proposal.
  const fingerprints = new Set<string>();
  let excluded = 0;
  for (const row of rows) {
    const f = row.finding;
    const event = row.ruling;
    const binding = bindings.get(f.id);
    const fingerprint = f.fingerprint;
    if (event === undefined || event.decision !== 'dismiss_approved' || !sameScope(event, scope) ||
      binding === undefined || binding.findingId !== f.id || binding.valueTag !== f.valueTag || !sameBinding(event, binding) ||
      f.origin !== 'gitleaks' || f.scanner !== 'gitleaks' || typeof fingerprint !== 'string' ||
      fingerprint.length === 0 || fingerprint.length > 512 || /^\s*#/.test(fingerprint) || /[\u0000-\u001f\u007f]/.test(fingerprint)) {
      excluded++; continue;
    }
    try { serializeSafe(fingerprint, 'export', guard, f.id); }
    catch (error) {
      if (!(error instanceof LeakGuardError)) throw error;
      excluded++; continue;
    }
    fingerprints.add(fingerprint);
  }
  const text = checkedExportText([...fingerprints].join('\n') + (fingerprints.size > 0 ? '\n' : ''), guard);
  return { text, included: fingerprints.size, excluded };
}
