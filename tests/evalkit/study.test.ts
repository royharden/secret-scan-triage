import { describe, expect, it } from 'vitest';
import { bindThresholdLineage, operatingIdentity, studyIdentity, validateFrozenStudy, validateThresholdLineage } from '../../scripts/study.ts';
import type { FrozenStudy } from '../../scripts/study.ts';
import type { SynthManifest } from '../../src/core/synth/generator.ts';
import { createMockJudge } from '../../src/core/providers/mock.ts';
import { loadThresholds, ThresholdsError } from '../../src/core/policy/thresholds.ts';
import { fakeLive, sample, thresholds } from './helpers.ts';

const samples = [sample(0, true, 'A', 'dev'), sample(1, false, 'B', 'heldout')];
const promotion = { target_recall: .98, equivalence_enabled: false, margin: null };
const configuration = { promptFingerprint: 'fixture-prompt', signalsVersion: 'fixture-signals' };
const manifest: SynthManifest = { generatorVersion: 'fixture', seed: 26, requestedSize: 2, variant: 'run1', frozenAt: null,
  counts: { records: 2, gitleaks: 2, trufflehog: 0, real: 1, negative: 1,
    bySplit: { dev: { groups: 1, records: 1, real: 1, negative: 0 }, heldout: { groups: 1, records: 1, real: 0, negative: 1 } }, byTrap: {} },
  splits: { A: 'dev', B: 'heldout' }, groups: [{ id: 'A', split: 'dev', gitMode: false, files: 1, records: 1 },
    { id: 'B', split: 'heldout', gitMode: false, files: 1, records: 1 }],
  run2: { contextChangedKey: 'fixture-context', replacedKey: 'fixture-value' }, notes: [] };
describe('frozen study and live dev threshold gate (unexecuted)', () => {
  it('round-trips the CLI artifact through the actual shared policy/worker loader and full study validation', async () => {
    // what_bug_this_catches: CLI-written lineage was an unknown key to the shared loader used by CLI, study and worker.
    const study = await studyIdentity(manifest, samples, promotion, configuration);
    const dev = samples.filter(s => s.split === 'dev');
    const descriptor = fakeLive(() => .9).descriptor;
    const operating = await operatingIdentity(configuration, { generative: descriptor, jev: null });
    for (const infeasible of [false, true]) {
      const tuned = { ...thresholds, source: 'dev-tuned' as const, judge_dismiss_enabled: !infeasible, infeasible };
      const artifact = await bindThresholdLineage(tuned, study.hash, dev, operating, descriptor);
      const reloaded = JSON.parse(JSON.stringify(artifact));
      const policy = loadThresholds(reloaded); // Same shared loader called by worker/importReport and CLI initial load.
      expect(policy).toEqual(tuned);
      expect(Object.keys(policy)).not.toContain('lineage');
      expect(Object.keys(policy)).not.toContain('counts');
      await expect(validateThresholdLineage(reloaded, study.hash, dev, operating)).resolves.toMatchObject({ infeasible });
      expect(() => loadThresholds({ ...reloaded, arbitrary_metadata: true })).toThrow(ThresholdsError);
      for (const lineage of [null, [], { ...artifact.lineage, origin: 'scripted-mock' },
        { ...artifact.lineage, studyHash: 'invalid' }, { ...artifact.lineage, devReal: dev.length + 1 },
        { ...artifact.lineage, unexpected: true }]) {
        expect(() => loadThresholds({ ...reloaded, lineage })).toThrow(ThresholdsError);
      }
      expect(() => loadThresholds({ ...reloaded, source: 'untuned-default' })).toThrow(ThresholdsError);
    }
  });
  it('rejects changed/swap assignments with unchanged totals; lifecycle-only updates preserve the identity', async () => {
    // what_bug_this_catches: aggregate-count equality did not pin the actual grouped split.
    const expected = await studyIdentity(manifest, samples, promotion, configuration);
    const frozen: FrozenStudy = { ...manifest, frozenAt: '2026-10-24T00:00:00Z', promotion, studyHash: expected.hash, studyIdentity: expected.identity };
    for (const changed of [
      { ...frozen, splits: { ...frozen.splits, A: 'heldout' } },
      { ...frozen, splits: { A: 'heldout', B: 'dev' }, groups: frozen.groups.map(g => ({ ...g, split: g.split === 'dev' ? 'heldout' : 'dev' })) },
      { ...frozen, requestedSize: 3 },
    ]) await expect(validateFrozenStudy(changed, manifest, expected)).rejects.toThrow();
    await expect(validateFrozenStudy({ ...frozen, heldoutRunAt: '2026-10-25T00:00:00Z', heldoutStatus: 'started' }, manifest, expected)).resolves.toMatchObject({ studyHash: expected.hash });
    const reassigned = samples.map(s => ({ ...s, group: s.group === 'A' ? 'B' : 'A' }));
    expect((await studyIdentity(manifest, reassigned, promotion, configuration)).hash).not.toBe(expected.hash);
  });
  it('rejects untuned, wrong-study/model/config, edited and mock artifacts; accepts actual dev-tuned conservative lineage', async () => {
    // what_bug_this_catches: --live could use shipped thresholds or unrelated dev tuning for its primary held-out run.
    const study = await studyIdentity(manifest, samples, promotion, configuration);
    const dev = samples.filter(s => s.split === 'dev');
    const descriptor = fakeLive(() => .9).descriptor;
    const operating = await operatingIdentity(configuration, { generative: descriptor, jev: null });
    await expect(validateThresholdLineage(thresholds, study.hash, dev, operating)).rejects.toThrow();
    const tuned = { ...thresholds, source: 'dev-tuned' as const, judge_dismiss_enabled: false, infeasible: true };
    const artifact = await bindThresholdLineage(tuned, study.hash, dev, operating, descriptor);
    await expect(validateThresholdLineage(artifact, study.hash, dev, operating)).resolves.toMatchObject({ infeasible: true });
    await expect(validateThresholdLineage(artifact, 'other-study', dev, operating)).rejects.toThrow();
    const differentModel = await operatingIdentity(configuration, { generative: { ...descriptor, modelId: 'another-model' }, jev: null });
    const differentConfig = await operatingIdentity({ ...configuration, signalsVersion: 'changed' }, { generative: descriptor, jev: null });
    for (const changed of [differentModel, differentConfig]) await expect(validateThresholdLineage(artifact, study.hash, dev, changed)).rejects.toThrow();
    await expect(validateThresholdLineage({ ...artifact, t_keep: .9 }, study.hash, dev, operating)).rejects.toThrow();
    await expect(validateThresholdLineage({ ...artifact, counts: { n: 99, real: 1 } }, study.hash, dev, operating)).rejects.toThrow();
    await expect(bindThresholdLineage(tuned, study.hash, dev, operating, createMockJudge(26).descriptor)).rejects.toThrow();
  });
});
