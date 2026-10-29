import { unsafeMarkSafe } from '../../src/core/safe.ts';
import type { Sample, Observation } from '../../src/core/evalkit/types.ts';
import type { JudgeResult } from '../../src/core/judge/contract.ts';
import type { DescribedJudge } from '../../src/core/providers/types.ts';

export const thresholds = { source: 'untuned-default' as const, judge_dismiss_enabled: false, t_dismiss: .05, t_keep: .85, target_recall: .98 };
export function sample(index: number, label: boolean, group = `g${index}`, split: 'dev' | 'heldout' = 'heldout'): Sample {
  return {
    key: `candidate-${index}`, label, group, split,
    emulation: { stopword: false, allowedPath: false, lowEntropy: false },
    finding: {
      id: `finding-${index}`, scanner: 'gitleaks', origin: 'gitleaks', ruleId: 'generic', path: 'src/config.ts', line: index + 1,
      maskedValue: unsafeMarkSafe('*'.repeat(20)), length: 20, charClass: 'alnum', verified: 'unknown', verifiedLabel: 'unknown', valueTag: (index + 1).toString(16).padStart(64, '0'),
      features: { length: 20, charClass: 'alnum', entropy: 3, lengthBucket: 'm', entropyBucket: 'mid', pathClass: 'config' },
      signals: [], maskedWindow: [{ lineId: 'L0', text: unsafeMarkSafe('value = ********************') }],
      flags: { injection: false, malformedEvidence: false, contextMismatch: false, unmaskableContext: false },
    },
  };
}
export function result(p: number, provider = 'anthropic', modelId = 'fake-live-test'): JudgeResult {
  return { p_real: p, reason_code: 'looks_real', status: 'ok', provider, modelId, cited_lines: ['L0'], usage: { calls: 1, inputTokens: 10, outputTokens: 5, usd: .01 } };
}
export function observation(s: Sample, band: Observation['band'], p?: number): Observation {
  return { sampleKey: s.key, band, source: p === undefined ? 'deterministic' : 'live', origin: p === undefined ? 'deterministic' : 'live', ...(p === undefined ? {} : { judge: result(p) }) };
}
/** Fake injected implementation only: no provider, credentials or network are used by these unit tests. */
export function fakeLive(score: (id: string) => number, kind: 'generative-llm' | 'system-one' = 'generative-llm'): DescribedJudge {
  const provider = kind === 'system-one' ? 'typesafe' as const : 'anthropic' as const;
  const modelId = `fake-${kind}-test`;
  return {
    id: modelId,
    descriptor: { id: modelId, provider, modelId, kind, isLlm: kind === 'generative-llm', citationsRequired: kind === 'generative-llm' },
    async judge(view) { return result(score(view.findingId), provider, modelId); },
  };
}
