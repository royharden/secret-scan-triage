import { createRng } from '../rng.ts';
import type { Sample } from './types.ts';

/** Existing generator split assignments are authoritative; this verifies rather than silently re-splitting them. */
export function validateSamples(samples: readonly Sample[]): void {
  const keys = new Set<string>();
  const splits = new Map<string, string>();
  const valueGroups = new Map<string, string>();
  for (const sample of samples) {
    if (typeof sample.key !== 'string' || !sample.key || keys.has(sample.key) || typeof sample.group !== 'string' || !sample.group || typeof sample.label !== 'boolean') throw new Error('Invalid sample.');
    if (sample.split !== 'dev' && sample.split !== 'heldout') throw new Error('Invalid split.');
    if (splits.has(sample.group) && splits.get(sample.group) !== sample.split) throw new Error('Group crosses splits.');
    const tag = sample.finding.valueTag;
    if (valueGroups.has(tag) && valueGroups.get(tag) !== sample.group) throw new Error('Repeated value crosses groups.');
    for (const fact of ['stopword', 'allowedPath', 'lowEntropy'] as const) if (typeof sample.emulation[fact] !== 'boolean') throw new Error('Invalid emulation fact.');
    keys.add(sample.key); splits.set(sample.group, sample.split); valueGroups.set(tag, sample.group);
  }
}

/** Utility for external datasets already grouped by repository/value-connected component. Never split individual rows. */
export function groupedSplit<T extends { group: string }>(
  samples: readonly T[], seed: number, devFraction = 0.5,
): { dev: T[]; heldout: T[]; assignments: Record<string, 'dev' | 'heldout'> } {
  if (!Number.isFinite(devFraction) || devFraction <= 0 || devFraction >= 1) throw new Error('Invalid split fraction.');
  const groups = createRng(seed).shuffle([...new Set(samples.map((s) => s.group))].sort());
  const dev = new Set(groups.slice(0, Math.ceil(groups.length * devFraction)));
  const assignments = Object.fromEntries(groups.map((g) => [g, dev.has(g) ? 'dev' as const : 'heldout' as const]));
  return { dev: samples.filter((s) => dev.has(s.group)), heldout: samples.filter((s) => !dev.has(s.group)), assignments };
}
