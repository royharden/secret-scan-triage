import { describe, expect, it } from 'vitest';
import { exportMaskedJson } from '../../src/core/export/json.ts';
import { buildLeakGuard } from '../../src/core/mask/leakIndex.ts';
import { NOT_READY_GUARD } from '../../src/core/safe.ts';

describe('guarded JSON export', () => {
  it('omits unsafe rows individually and records blocked review count', () => {
    const raw = ['qR8', 'sT9', 'uV4'].join('');
    const guard = buildLeakGuard([raw], [], new Uint8Array(32).fill(3));
    const output = exportMaskedJson([{ finding: '*********' }, { finding: raw }], guard, 2);
    expect(output.exported).toBe(1);
    expect(output.blocked).toBe(3);
    expect(JSON.parse(output.json).findings).toEqual([{ finding: '*********' }]);
    expect(output.json).not.toContain(raw);
  });
  it('requires a ready current-session guard, including on an empty export', () => {
    // what_bug_this_catches: reloading must not turn the export path into an unchecked JSON.stringify call.
    expect(() => exportMaskedJson([], NOT_READY_GUARD)).toThrow();
  });
});
