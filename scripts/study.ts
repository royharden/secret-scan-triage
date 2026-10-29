// Pure study/threshold lineage. No files, provider calls or CLI execution; eval.ts owns the ordered writes/dispatch.
import type { SynthManifest } from '../src/core/synth/generator.ts';
import type { Sample } from '../src/core/evalkit/types.ts';
import type { Thresholds } from '../src/core/policy/thresholds.ts';
import { loadThresholds } from '../src/core/policy/thresholds.ts';
import type { JudgeDescriptor } from '../src/core/providers/types.ts';
import { sha256Hex, stableStringify } from '../src/core/judge/fingerprint.ts';

export interface PromotionConfig { target_recall: number; equivalence_enabled: boolean; margin: number | null }
function datasetIdentity(manifest: SynthManifest) {
  return { generatorVersion: manifest.generatorVersion, seed: manifest.seed, requestedSize: manifest.requestedSize,
    variant: manifest.variant, counts: manifest.counts, splits: manifest.splits,
    groups: [...manifest.groups].sort((a, b) => a.id.localeCompare(b.id)), run2: manifest.run2, notes: manifest.notes };
}
export function populationIdentity(samples: readonly Sample[]) {
  return samples.map(({ key, group, split, label, trap }) => ({ key, group, split, label, trap: trap ?? null }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
export async function studyIdentity(manifest: SynthManifest, samples: readonly Sample[], promotion: PromotionConfig, configuration: unknown) {
  const identity = { version: 1, dataset: datasetIdentity(manifest), population: populationIdentity(samples), promotion, configuration };
  return { identity, hash: await sha256Hex(stableStringify(identity)) };
}
export type StudyIdentity = Awaited<ReturnType<typeof studyIdentity>>;
export function operatingIdentity(configuration: unknown, judges: { generative: JudgeDescriptor | null; jev: JudgeDescriptor | null }): Promise<string> {
  return sha256Hex(stableStringify({ configuration, judges }));
}
export interface FrozenStudy extends SynthManifest {
  frozenAt: string;
  promotion: PromotionConfig;
  studyHash: string;
  studyIdentity: StudyIdentity['identity'];
  heldoutRunAt?: string;
  heldoutStatus?: string;
}
/** Compare top-level pinned assignments AND their identity/hash. Lifecycle markers alone may change. */
export async function validateFrozenStudy(previous: unknown, manifest: SynthManifest, expected: StudyIdentity): Promise<FrozenStudy> {
  if (!previous || typeof previous !== 'object') throw new Error('');
  const pinned = previous as FrozenStudy;
  if (typeof pinned.frozenAt !== 'string' || !Number.isFinite(Date.parse(pinned.frozenAt))
    || pinned.studyHash !== expected.hash || stableStringify(pinned.studyIdentity) !== stableStringify(expected.identity)
    || pinned.studyHash !== await sha256Hex(stableStringify(pinned.studyIdentity))
    || stableStringify(datasetIdentity(pinned)) !== stableStringify(datasetIdentity(manifest))
    || stableStringify(pinned.promotion) !== stableStringify(expected.identity.promotion)) throw new Error('');
  return pinned;
}
export interface ThresholdLineage {
  version: 1; origin: 'live'; method: 'generative'; studyHash: string; devPopulationHash: string;
  devCount: number; devReal: number; operatingHash: string; thresholdHash: string;
}
export interface ThresholdArtifact extends Thresholds {
  counts: { n: number; real: number };
  tuned_at: string;
  lineage: ThresholdLineage;
}
/** Called only after tuneDev has accepted actual live-origin dev observations. No mock can establish lineage. */
export async function bindThresholdLineage(thresholds: Thresholds, studyHash: string, dev: readonly Sample[], operatingHash: string,
  descriptor: JudgeDescriptor): Promise<ThresholdArtifact> {
  const checked = loadThresholds(thresholds);
  if (checked.source !== 'dev-tuned' || checked.target_recall !== .98 || descriptor.kind === 'scripted-mock' || !dev.length || dev.some(s => s.split !== 'dev')) throw new Error('');
  const counts = { n: dev.length, real: dev.filter(s => s.label).length };
  return { ...checked, counts, tuned_at: new Date().toISOString(), lineage: { version: 1, origin: 'live', method: 'generative',
    studyHash, devPopulationHash: await sha256Hex(stableStringify(populationIdentity(dev))), devCount: counts.n, devReal: counts.real,
    operatingHash, thresholdHash: await sha256Hex(stableStringify(checked)) } };
}
/** Gate before live held-out dispatch: untuned, unrelated, edited, or mock-lineage artifacts fail closed. */
export async function validateThresholdLineage(value: unknown, studyHash: string, dev: readonly Sample[], operatingHash: string): Promise<ThresholdArtifact> {
  const artifact = value as ThresholdArtifact;
  const checked = loadThresholds(value);
  const lineage = artifact?.lineage;
  const real = dev.filter(s => s.label).length;
  if (checked.source !== 'dev-tuned' || checked.target_recall !== .98 || !dev.length || dev.some(s => s.split !== 'dev')
    || !lineage || lineage.version !== 1 || lineage.origin !== 'live' || lineage.method !== 'generative'
    || lineage.studyHash !== studyHash || lineage.operatingHash !== operatingHash
    || lineage.devPopulationHash !== await sha256Hex(stableStringify(populationIdentity(dev)))
    || lineage.devCount !== dev.length || lineage.devReal !== real || artifact.counts?.n !== dev.length || artifact.counts.real !== real
    || lineage.thresholdHash !== await sha256Hex(stableStringify(checked))
    || typeof artifact.tuned_at !== 'string' || !Number.isFinite(Date.parse(artifact.tuned_at))) throw new Error('');
  return artifact;
}
