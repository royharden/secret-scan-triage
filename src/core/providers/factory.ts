import { judgeWithRetry } from '../judge/validate.ts';
import type { DescribedJudge } from './types.ts';
import type { RawJudgeCaller } from '../judge/contract.ts';
import { addUsage, failedResult, notRequestedResult } from '../judge/contract.ts';
import { createRawCaller } from './rawtransport.ts';
import type { ProviderDependencies } from './rawtransport.ts';
import type { ServerProviderConfig } from './serverConfig.ts';
import { anthropicProtocol } from './anthropic.ts';
import { openaiCompatibleProtocol } from './openaiCompatible.ts';
import { typesafeProtocol } from './typesafe.ts';
import { stableStringify } from '../judge/fingerprint.ts';
import { screenInjection } from '../screen/prefilter.ts';
import { screenSemantic, SEMANTIC_SCREEN_VERSION } from '../screen/semantic.ts';
export type { ServerProviderConfig } from './serverConfig.ts';
export type { ProviderDependencies } from './rawtransport.ts';
export function makeRawProviderCaller(config: ServerProviderConfig, deps: ProviderDependencies): RawJudgeCaller {
  const protocol = config.provider === 'anthropic' ? anthropicProtocol :
    config.provider === 'openai_compatible' ? openaiCompatibleProtocol : typesafeProtocol;
  return createRawCaller(config, deps, protocol);
}
export function makeProviderJudge(config: ServerProviderConfig, deps: ProviderDependencies): DescribedJudge {
  const caller = makeRawProviderCaller(config, deps);
  // Cache uses descriptor.id as adapterVersion. Include exact dev-fit bytes, not merely a re-usable fit label.
  // Bump adapter-v1 on protocol/question edits; transport separately SHA-256 fingerprints the complete protocol text.
  const id = `${caller.id}:adapter-v1:${stableStringify({ calibration: config.typeSafeCalibration ?? null,
    semanticScreenEnabled: config.semanticScreenEnabled === true, semanticScreenVersion: SEMANTIC_SCREEN_VERSION })}`;
  return { id, descriptor: { id, provider: config.provider, modelId: config.modelId,
    kind: config.provider === 'typesafe' ? 'system-one' : 'generative-llm', isLlm: true,
    citationsRequired: caller.citationsRequired }, async judge(view) {
      if (view.scannerVerified) return notRequestedResult(config.provider, config.modelId);
      if (screenInjection([view.maskedLine, ...view.maskedWindow.map((line) => line.text)])) {
        return failedResult(config.provider, config.modelId, 'invalid_output');
      }
      if (config.semanticScreenEnabled === true && config.provider !== 'typesafe') {
        const screen = await screenSemantic(view, config, deps, { enabled: true });
        if (screen.status !== 'clear') {
          const failed = failedResult(config.provider, config.modelId, 'invalid_output', screen.usage);
          if (screen.usage_estimated) failed.usage_estimated = true;
          if (screen.usage_unknown) failed.usage_unknown = true;
          return failed;
        }
        const result = await judgeWithRetry(caller, view, deps.guard);
        result.usage = addUsage(screen.usage, result.usage);
        if (screen.usage_estimated) result.usage_estimated = true;
        if (screen.usage_unknown) result.usage_unknown = true;
        return result;
      }
      return judgeWithRetry(caller, view, deps.guard);
    } };
}
