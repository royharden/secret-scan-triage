// Explicitly run after source edits OUTSIDE Dirty Mode. Construction materializes these byte copies with filesystem ops.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const CORE_FILES = Object.freeze([
  'finding.ts', 'safe.ts',
  'features/charclass.ts', 'features/entropy.ts', 'features/buckets.ts', 'features/shapes.ts',
  'mask/leakGuard.ts', 'mask/tokens.ts',
  'judge/contract.ts', 'judge/schema.ts', 'judge/validate.ts', 'judge/prompt.ts', 'judge/fingerprint.ts',
  'providers/types.ts', 'providers/serverConfig.ts', 'providers/rawtransport.ts', 'providers/anthropic.ts',
  'providers/openaiCompatible.ts', 'providers/typesafe.ts', 'providers/factory.ts',
  'ledger/prices.ts', 'ledger/callledger.ts', 'screen/prefilter.ts', 'screen/semantic.ts',
] as const);
export function assertClosedCore(root: string): void {
  const core = resolve(root, 'src/core');
  const allowed = new Set(CORE_FILES.map((file) => resolve(core, file)));
  for (const file of CORE_FILES) {
    const source = readFileSync(resolve(core, file), 'utf8');
    if (/\bimport\s*\(/.test(source)) throw new Error(`Dynamic import in staged core: ${file}`);
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith('.') || !allowed.has(resolve(core, dirname(file), specifier))) {
        throw new Error(`Import leaves fixed staged core: ${file}`);
      }
    }
  }
}
export function syncFunctionContract(root: string): void {
  assertClosedCore(root); // closure verified before any copy, never a partial copy with unresolved imports
  for (const file of CORE_FILES) {
    const target = resolve(root, 'supabase/functions/triage-judge/_shared/core', file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, 'src/core', file), target);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncFunctionContract(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
