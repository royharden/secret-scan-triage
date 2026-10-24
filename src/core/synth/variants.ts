// Run-2 variant (Claude §1.3 step 5, T19). Identical to run 1 except:
//  (a) one context line changed directly above one decided finding (its masked window changes -> back to review), and
//  (b) the T19 token replaced by a value of the same length and per-position character class under the same fingerprint
//      (same file, rule, line), so the mask shape is identical and only the keyed valueTag changes.
import type { Rng } from '../rng.ts';
import type { PlacedFinding, SynthModel } from './generator.ts';
import { labelKey } from './emit.ts';
import { TOKEN_KINDS, TOKEN_SPECS, sameShapeReplacement } from './tokens.ts';
import { comment } from './traps.ts';

function gitleaksKey(f: PlacedFinding): string {
  return labelKey('gitleaks', f.path, f.line, f.gitleaksRule as string);
}

function prefixLength(value: string): number {
  for (const k of TOKEN_KINDS) {
    const p = TOKEN_SPECS[k].prefix;
    if (value.startsWith(p)) return p.length;
  }
  return 0;
}

/**
 * Locate the two run-2 targets and, when `apply` is true, mutate the model in place.
 * Returns their label keys either way so run 1 and run 2 manifests can be joined.
 */
export function applyRun2(model: SynthModel, rng: Rng, apply: boolean): { contextChangedKey: string; replacedKey: string } {
  const replace = model.findings.find((f) => f.role === 'run2-replace' && f.gitleaksRule !== undefined);
  const ctx = model.findings.find((f) => f.role === 'run2-context' && f.gitleaksRule !== undefined);
  if (replace === undefined || ctx === undefined) throw new Error('synth: run-2 targets missing');
  const keys = { contextChangedKey: gitleaksKey(ctx), replacedKey: gitleaksKey(replace) };
  if (!apply) return keys;

  const files = new Map(model.files.map((f) => [f.path, f]));

  // (b) same-shape replacement of the T19 value.
  const file = files.get(replace.path);
  if (file === undefined) throw new Error('synth: run-2 replace file missing');
  const old = replace.value;
  const next = sameShapeReplacement(old, prefixLength(old), rng);
  const text = file.lines[replace.line - 1] as string;
  const at = text.indexOf(old);
  if (at < 0) throw new Error('synth: run-2 replace value not on its line');
  file.lines[replace.line - 1] = text.slice(0, at) + next + text.slice(at + old.length);
  for (const f of model.findings) if (f.value === old) f.value = next;

  // (a) context line directly above the decided finding.
  const cfile = files.get(ctx.path);
  if (cfile === undefined || ctx.line < 2) throw new Error('synth: run-2 context target invalid');
  const before = cfile.lines[ctx.line - 2] as string;
  let changed = comment(cfile.style, 'reviewed by the platform team (OPS-1042)');
  if (changed === before) changed = comment(cfile.style, 'reviewed again by the platform team (OPS-1043)');
  cfile.lines[ctx.line - 2] = changed;

  return keys;
}
