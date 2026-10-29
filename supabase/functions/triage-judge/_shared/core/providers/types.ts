// Provider-side types. The Judge contract itself lives in judge/contract.ts (one definition, copied into the edge function).
export type {
  Judge,
  JudgeFailure,
  JudgeResult,
  JudgeStatus,
  JudgeUsage,
  MaskedView,
  RawJudgeCaller,
  RawJudgeRequest,
  ReasonCode,
} from '../judge/contract.ts';
import type { Judge } from '../judge/contract.ts';

export type ProviderId = 'mock' | 'anthropic' | 'openai_compatible' | 'typesafe';

/**
 * What kind of judge produced a result. 'scripted-mock' is a deterministic script, NEVER an LLM: its rows are labelled
 * "interface replay; not yet measured" and cached with source 'scripted-mock'.
 */
export type JudgeKind = 'scripted-mock' | 'generative-llm' | 'system-one';

export interface JudgeDescriptor {
  id: string;
  provider: ProviderId;
  modelId: string;
  kind: JudgeKind;
  /** False for the scripted mock; only live adapters may set true. */
  isLlm: boolean;
  /** Generative adapters must cite window line ids; Jev may omit citations. */
  citationsRequired: boolean;
}

export type DescribedJudge = Judge & { readonly descriptor: JudgeDescriptor };

/** Provenance written next to cached judge outputs (Claude §1.1 item 12). */
export type CacheSource = 'scripted-mock' | 'live' | 'replay';
