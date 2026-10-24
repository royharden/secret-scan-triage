import { describe, expect, it, vi } from 'vitest';
import { failureResponse, processImport } from '../../src/worker/importReport.ts';
import { MAX_BYTES, ImportError } from '../../src/core/ingest/index.ts';
import { restoreGuard } from '../../src/core/mask/guardSnapshot.ts';
import { pipelineConfig } from '../../src/core/pipeline.ts';
import { receiveItems } from '../../src/app/session.ts';
import { exportMaskedJson } from '../../src/core/export/json.ts';

const projectSalt = new Uint8Array(32).fill(26);

describe('worker-owned import', () => {
  it('refuses an oversized File before reading any contents', async () => {
    // what_bug_this_catches: File.text on the page or before the size check exposes/allocates an oversized raw report.
    const text = vi.fn(async () => 'must not be read');
    const file = { size: MAX_BYTES + 1, text } as unknown as File;
    await expect(processImport({ kind: 'file', file, format: 'auto', verificationEnabled: false, projectSalt })).rejects.toMatchObject({ code: 'too_large' });
    expect(text).not.toHaveBeenCalled();
  });

  it.each(['auto', 'gitleaks'] as const)('imports a File with %s format and retains a page/export guard', async (format) => {
    const raw = ['Zp8', 'Qm4', 'Ta9', 'We6', 'Yc2', 'Nb7'].join('');
    const report = JSON.stringify([{ RuleID: 'generic-api-key', File: 'src/config.ts', StartLine: 1, Secret: raw, Match: `const value = '${raw}'` }]);
    const result = await processImport({ kind: 'file', file: new File([report], 'scan.json'), format, verificationEnabled: false, projectSalt });
    const guard = restoreGuard(structuredClone(result.snapshot), pipelineConfig().prefixes);
    const received = receiveItems(result.rows, guard);
    expect(received.items.length + result.blocked + received.blocked).toBe(1);
    expect(received.items).toHaveLength(1);
    expect(result.rows.join('')).not.toContain(raw);
    const exported = exportMaskedJson(received.items, guard, result.blocked);
    expect(exported.json).not.toContain(raw);
    expect(JSON.parse(exported.json).source).toBe('scripted-mock');
    expect(() => guard.check(raw.slice(0, 6), 'export')).toThrow();
  });

  it('keeps safe rows when an unsafe fingerprint/digest row is blocked', async () => {
    // what_bug_this_catches: ordinary demo digest collisions must not turn one rejected finding into total import failure.
    const result = await processImport({ kind: 'demo', format: 'gitleaks', projectSalt });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length + result.blocked).toBe(result.candidates);
    const guard = restoreGuard(structuredClone(result.snapshot), pipelineConfig().prefixes);
    expect(receiveItems(result.rows, guard).blocked).toBe(0);
  });

  it('sends only structural failure codes/counts/locations, never caught messages', () => {
    expect(failureResponse(new Error('never emit this report fragment'))).toEqual({ kind: 'error', code: 6 });
    expect(failureResponse(new ImportError('malformed', { location: 'record 7', count: 2 }))).toEqual({ kind: 'error', code: 5, locationKind: 1, locationIndex: 7, count: 2 });
  });
});
