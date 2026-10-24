import { sameBinding } from '../rulings/binding.ts';
import type { RulingBinding } from '../rulings/types.ts';
import { createRng, hashString32 } from '../rng.ts';

export interface AuditCohort {
  readonly id: string;
  readonly runId: string;
  readonly seed: number;
  readonly populationSize: number;
  readonly members: readonly Readonly<RulingBinding>[];
}
export function auditSampleSize(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('');
  return Math.min(n, Math.max(5, Math.ceil(0.05 * n)));
}
/** Frozen membership is held separately from visible rows. Labeling must never expose a cohort marker. */
export function createAuditCohort(runId: string, dismissalBindings: readonly RulingBinding[], seed: number): AuditCohort {
  if (typeof runId !== 'string' || runId.length === 0 || !Number.isFinite(seed)) throw new Error('');
  const unique = new Map<string, RulingBinding>();
  for (const binding of dismissalBindings) {
    const previous = unique.get(binding.findingId);
    // One finding cannot represent two bindings in a single immutable run.
    if (previous !== undefined && !sameBinding(previous, binding)) throw new Error('');
    unique.set(binding.findingId, { findingId: binding.findingId, contentHash: binding.contentHash, valueTag: binding.valueTag });
  }
  // Canonical population order makes a seed independent of queue presentation order.
  const population = [...unique.values()].sort((a, b) => a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0);
  const rng = createRng(seed);
  const members = Object.freeze(rng.sample(population, auditSampleSize(population.length)).map((binding) => Object.freeze(binding)));
  const identity = JSON.stringify([runId, rng.seed, population]);
  const id = `audit:${runId}:${rng.seed}:${hashString32(identity).toString(16)}`;
  return Object.freeze({ id, runId, seed: rng.seed, populationSize: population.length, members });
}
