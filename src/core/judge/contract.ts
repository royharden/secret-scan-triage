// Judge contract (Claude §1.1 items 5-6, §2.6). Copied byte-for-byte into the edge function by
// scripts/sync-function-contract.ts (merged PLAN C12), so it imports only finding.ts and safe.ts.
import type { CharClass, Features, MaskedLine, PathClass } from '../finding.ts';
import type { SafeText } from '../safe.ts';

export const REASON_CODES = Object.freeze([
  'placeholder',
  'reference_not_literal',
  'test_value',
  'hash_or_id',
  'docs_example',
  'looks_real',
  'cannot_tell',
] as const);

export type ReasonCode = (typeof REASON_CODES)[number];

export function isReasonCode(x: unknown): x is ReasonCode {
  return typeof x === 'string' && (REASON_CODES as ReadonlyArray<string>).includes(x);
}

/**
 * Everything a judge may see. Masked only; full paths stay in the browser (basename only). Serialised size <= 4 KiB
 * (MAX_VIEW_BYTES). Built only by judge/views.ts.
 */
export interface MaskedView {
  findingId: string;
  ruleId: string;
  pathClass: PathClass;
  basename: SafeText;
  maskedLine: SafeText;
  /** Masked window lines with ids ('L0' = match line, 'L-1', 'L+1', ...). */
  maskedWindow: MaskedLine[];
  lengthBucket: Features['lengthBucket'];
  entropyBucket: Features['entropyBucket'];
  charClass: CharClass;
  /** `${id}:${direction}:${strength}` per deterministic signal; empty for the LLM-only baseline view. */
  signalBuckets: string[];
  scannerVerified: boolean;
}

export const MAX_VIEW_BYTES = 4096;
export const MAX_MODEL_TEXT_CHARS = 200;
export const MODEL_TEXT_LABEL = 'model-authored';

export type JudgeStatus = 'ok' | 'not_requested' | 'failed';

export interface JudgeUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export type JudgeFailure = 'invalid_output' | 'provider_error' | 'leak_guard' | 'oversize_view';

export interface JudgeResult {
  /** Finite in [0, 1] when status is 'ok'; NaN otherwise so that no threshold comparison can ever succeed by accident. */
  p_real: number;
  reason_code: ReasonCode;
  /** Validated line ids inside the supplied window. Undefined = "not provided" (allowed for Jev only). */
  cited_lines?: string[];
  usage: JudgeUsage;
  status: JudgeStatus;
  /** Optional free text: escaped, <= 200 chars, re-checked by the leak guard. Always display with model_text_label. */
  model_text?: SafeText;
  model_text_label?: typeof MODEL_TEXT_LABEL;
  provider: string;
  modelId: string;
  /** Present when status is 'failed'. Our own code, never model or report text. */
  failure?: JudgeFailure;
}

export interface Judge {
  id: string;
  judge(view: MaskedView): Promise<JudgeResult>;
}

/** One raw provider attempt, used by judgeWithRetry. Adapters reserve budget per attempt (ledger, M5). */
export interface RawJudgeRequest {
  view: MaskedView;
  /** serializeSafe(view, 'judge_request', guard): the only body an adapter may send. */
  body: string;
  /** 1 for the first attempt, 2 for the single retry. */
  attempt: 1 | 2;
}

export interface RawJudgeCaller {
  id: string;
  provider: string;
  modelId: string;
  /** Generative adapters must cite window line ids; Jev (typesafe) citations are optional. */
  citationsRequired: boolean;
  /** Returns unparsed model output (string or object) plus usage for this attempt. Throws on provider error. */
  call(req: RawJudgeRequest): Promise<{ output: unknown; usage: JudgeUsage }>;
}

export const ZERO_USAGE: JudgeUsage = Object.freeze({ calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });

export function addUsage(a: JudgeUsage, b: JudgeUsage): JudgeUsage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    usd: a.usd + b.usd,
  };
}

export function notRequestedResult(provider = 'none', modelId = 'none'): JudgeResult {
  return { p_real: Number.NaN, reason_code: 'cannot_tell', usage: { ...ZERO_USAGE }, status: 'not_requested', provider, modelId };
}

export function failedResult(provider: string, modelId: string, failure: JudgeFailure, usage: JudgeUsage = ZERO_USAGE): JudgeResult {
  return { p_real: Number.NaN, reason_code: 'cannot_tell', usage: { ...usage }, status: 'failed', provider, modelId, failure };
}
