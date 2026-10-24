import { describe, expect, it, vi } from 'vitest';
import { runEvaluation } from '../../src/core/evalkit/run.ts';
import { fakeLive, sample, thresholds } from '../evalkit/helpers.ts';
import { guardFor } from '../rulings/fixtures.ts';
describe('Node-only LLM comparator', () => {
  it('uses a distinct masked raw judge without the deployed verified-real shortcut', async () => {
    // what_bug_this_catches: adding operational provider screening must not silently turn LLM-only into a combined baseline.
    const candidate = sample(0, true);
    candidate.finding.verified = 'verified'; candidate.finding.verifiedLabel = 'verified';
    candidate.finding.signals = [{ id: 'S-R1', name: 'verified', direction: 'real', strength: 'decisive', evidence: { kind: 'line', lineId: 'L0' } }];
    const configured = fakeLive(() => .9); const bare = fakeLive(() => .1);
    const deployedCall = vi.fn(configured.judge); const baselineCall = vi.fn(bare.judge);
    const output = await runEvaluation({ samples: [candidate], guard: guardFor(), thresholds, highPrecisionRules: [],
      judges: { generative: { ...configured, judge: deployedCall }, llmOnly: { ...bare, judge: baselineCall } },
      bootstrap: { seed: 26, groups: ['g0'], draws: [[0], [0]] } });
    expect(deployedCall).not.toHaveBeenCalled();
    expect(baselineCall).toHaveBeenCalledTimes(1);
    expect(baselineCall.mock.calls[0][0].scannerVerified).toBe(true);
    expect(output.methods.find(method => method.method === 'deterministic')?.observations[0].band).toBe('keep');
  });
});
