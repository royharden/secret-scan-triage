// Masked browser-download report. Never accepts/exports a guard snapshot or identity salt.
import type { LeakGuard } from '../safe.ts';
import { serializeSafe } from '../safe.ts';

export interface JsonExport { json: string; exported: number; blocked: number }

/** Each rejected row is omitted and counted; final envelope is guarded too (including all metadata/keys). */
export function exportMaskedJson(rows: readonly unknown[], guard: LeakGuard, previouslyBlocked = 0): JsonExport {
  if (!Number.isSafeInteger(previouslyBlocked) || previouslyBlocked < 0) throw new Error('');
  const findings: unknown[] = [];
  let blocked = previouslyBlocked;
  for (const row of rows) {
    try { findings.push(JSON.parse(serializeSafe(row, 'export', guard))); }
    catch { blocked++; }
  }
  const json = serializeSafe({
    schemaVersion: 1,
    source: 'scripted-mock',
    thresholds: 'untuned-default',
    dryRun: true,
    rulingsPersistence: 'memory-only',
    blockedForReview: blocked,
    findings,
  }, 'export', guard);
  return { json, exported: findings.length, blocked };
}
