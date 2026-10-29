import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_FILES, assertClosedCore } from '../../scripts/sync-function-contract.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
describe('one provider/core implementation in browser/Node/edge', () => {
  it('fixed staged list is closed under every relative import and all copies are byte equal', () => {
    expect(() => assertClosedCore(root)).not.toThrow();
    const staged = resolve(root, 'supabase/functions/triage-judge/_shared/core');
    const allowed = new Set(CORE_FILES.map((file) => resolve(staged, file)));
    for (const file of CORE_FILES) {
      const source = readFileSync(resolve(root, 'src/core', file));
      const copy = readFileSync(resolve(staged, file));
      expect(copy.equals(source), file).toBe(true);
      for (const m of copy.toString('utf8').matchAll(/\b(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
        expect(m[1]?.startsWith('.'), file).toBe(true);
        expect(allowed.has(resolve(staged, dirname(file), m[1]!)), file).toBe(true);
      }
    }
  });
});
