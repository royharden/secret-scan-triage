// Node-only live factory. No environment access or provider request occurs until the explicit --live path calls it.
import type { LeakGuard } from '../src/core/safe.ts';
import type { DescribedJudge } from '../src/core/providers/types.ts';
import { makeProviderJudge, makeRawProviderCaller } from '../src/core/providers/factory.ts';
import { loadServerProviderConfig } from '../src/core/providers/serverConfig.ts';
import type { LiveProviderId, ServerProviderConfig } from '../src/core/providers/serverConfig.ts';
import { judgeWithRetry } from '../src/core/judge/validate.ts';
import { MemoryCallLedger } from '../src/core/ledger/callledger.ts';
export async function createEvalJudges(guard: LeakGuard, maxUsd: number): Promise<{ generative?: DescribedJudge; jev?: DescribedJudge; llmOnly?: DescribedJudge }> {
  const ledger = new MemoryCallLedger({ capUsd: maxUsd }); // One cap shared by dev, held-out, all providers, screens and retries.
  const runId = globalThis.crypto.randomUUID();
  let sequence = 0;
  function wrap(config: ServerProviderConfig): DescribedJudge {
    const template = makeProviderJudge(config, { guard, ledger, requestId: `${runId}:descriptor` });
    return { id: template.id, descriptor: template.descriptor, judge: view => {
      const current = makeProviderJudge(config, { guard, ledger, requestId: `${runId}:${++sequence}` });
      return current.judge(view);
    } };
  }
  function bareLlm(config: ServerProviderConfig): DescribedJudge {
    const template = makeProviderJudge(config, { guard, ledger, requestId: `${runId}:descriptor` });
    const id = `${template.id}:eval-only-no-operational-stage`;
    return { id, descriptor: { ...template.descriptor, id }, judge: view => {
      // Evaluation baseline only: no verified/prefilter/semantic policy override. Privacy/limits/reservations still apply.
      const caller = makeRawProviderCaller(config, { guard, ledger, requestId: `${runId}:${++sequence}` });
      return judgeWithRetry(caller, view, guard);
    } };
  }
  const selected = process.env.JUDGE_EVAL_GENERATIVE_PROVIDER ?? 'anthropic';
  const provider: LiveProviderId | null = selected === 'anthropic' || selected === 'openai_compatible' ? selected : null;
  const generative = provider ? loadServerProviderConfig(process.env, provider) : null;
  const jev = loadServerProviderConfig(process.env, 'typesafe');
  return { ...(generative ? { generative: wrap(generative), llmOnly: bareLlm(generative) } : {}), ...(jev ? { jev: wrap(jev) } : {}) };
}
