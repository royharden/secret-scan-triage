// Judge output validation: tolerant parse (strip code fences, extract the bare object) then STRICT validation
// (enum, finite p_real in [0,1], cited lines inside the supplied window, free text escaped + capped + leak-guard re-checked).
// judgeWithRetry: one retry on invalid output, then status 'failed' (policy routes to review).
// Copied into the edge function (merged PLAN C12): imports stay inside {finding,safe}.ts, mask/leakGuard.ts (itself
// importing only safe.ts) and judge/{contract,schema}.ts. NOTE for the C12 sync list: it must include mask/leakGuard.ts.
import { serializeSafe } from '../safe.ts';
import type { LeakGuard } from '../safe.ts';
import { guardedSafeText } from '../mask/leakGuard.ts';
import {
  MAX_MODEL_TEXT_CHARS,
  ChargedProviderError,
  MAX_VIEW_BYTES,
  MODEL_TEXT_LABEL,
  ZERO_USAGE,
  addUsage,
  failedResult,
  isReasonCode,
} from './contract.ts';
import type { JudgeResult, JudgeUsage, MaskedView, RawJudgeCaller } from './contract.ts';
import { LINE_ID_PATTERN, MAX_CITED_LINES } from './schema.ts';

export interface Invalid {
  invalid: string;
}

export function isInvalid(x: unknown): x is Invalid {
  return typeof x === 'object' && x !== null && typeof (x as Invalid).invalid === 'string';
}

const FENCE = /^\s*```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?\s*```\s*$/;
const MAX_RAW_OUTPUT_CHARS = 64_000;

/** Extracts the first balanced top-level JSON object from text (string-aware). */
export function extractBareObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Tolerant parse: object passes through; strings may be fenced or wrapped in prose. Never echoes model text in errors. */
export function tolerantParse(raw: unknown): Record<string, unknown> | Invalid {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return { invalid: 'output is neither an object nor a string' };
  if (raw.length > MAX_RAW_OUTPUT_CHARS) return { invalid: 'output too long' };
  let text = raw.trim();
  const fenced = FENCE.exec(text);
  if (fenced && fenced[1] !== undefined) text = fenced[1].trim();
  const candidates = [text];
  const bare = extractBareObject(text);
  if (bare !== null && bare !== text) candidates.push(bare);
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return { invalid: 'no JSON object found in output' };
}

/** HTML-escapes and strips control / bidi characters. Applied to model free text before it is ever displayed. */
export function escapeModelText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/** Cap escaped output, preserving complete HTML entities and Unicode code points, including the final ellipsis. */
export function capModelText(s: string): string {
  if (s.length <= MAX_MODEL_TEXT_CHARS) return s;
  let out = '';
  // escapeModelText emits exactly these entities. Treat each entity and each code point as one indivisible unit.
  for (const m of s.matchAll(/&(?:amp|lt|gt|quot|#39|#96);|[\s\S]/gu)) {
    if (out.length + m[0].length > MAX_MODEL_TEXT_CHARS - 1) break;
    out += m[0];
  }
  return out + '…';
}

const ALLOWED_KEYS = new Set(['p_real', 'reason_code', 'cited_lines', 'model_text']);
const LINE_ID_RE = new RegExp(LINE_ID_PATTERN);

export interface ValidateMeta {
  provider: string;
  modelId: string;
  usage: JudgeUsage;
}

/**
 * Strict validation of one judge output against the view it answered. Returns a JudgeResult with status 'ok', or
 * `{ invalid }` with a reason written by this code (never containing model or report text).
 */
export function validateJudgeOutput(
  raw: unknown,
  view: MaskedView,
  opts: { citationsRequired: boolean },
  guard: LeakGuard,
  meta: ValidateMeta = { provider: 'unknown', modelId: 'unknown', usage: ZERO_USAGE },
): JudgeResult | Invalid {
  const parsed = tolerantParse(raw);
  if (isInvalid(parsed)) return parsed;

  for (const k of Object.keys(parsed)) if (!ALLOWED_KEYS.has(k)) return { invalid: 'unexpected key in output' };

  const p = parsed.p_real;
  if (typeof p !== 'number' || !Number.isFinite(p)) return { invalid: 'p_real is not a finite number' };
  if (p < 0 || p > 1) return { invalid: 'p_real outside [0, 1]' };

  const reason = parsed.reason_code;
  if (!isReasonCode(reason)) return { invalid: 'reason_code not in the fixed enum' };

  let cited: string[] | undefined;
  if (parsed.cited_lines !== undefined && parsed.cited_lines !== null) {
    const c = parsed.cited_lines;
    if (!Array.isArray(c) || !c.every((x) => typeof x === 'string')) return { invalid: 'cited_lines must be an array of strings' };
    if (c.length > MAX_CITED_LINES) return { invalid: 'too many cited_lines' };
    const allowed = new Set(view.maskedWindow.map((l) => l.lineId));
    allowed.add('L0');
    for (const id of c as string[]) {
      if (!LINE_ID_RE.test(id)) return { invalid: 'cited line id has an invalid format' };
      if (!allowed.has(id)) return { invalid: 'cited line outside the supplied window' };
    }
    cited = Array.from(new Set(c as string[]));
  }
  if (opts.citationsRequired && (cited === undefined || cited.length === 0)) {
    return { invalid: 'citations required but none provided' };
  }

  const result: JudgeResult = {
    p_real: p,
    reason_code: reason,
    usage: { ...meta.usage },
    status: 'ok',
    provider: meta.provider,
    modelId: meta.modelId,
  };
  if (cited !== undefined) result.cited_lines = cited;

  if (parsed.model_text !== undefined && parsed.model_text !== null) {
    if (typeof parsed.model_text !== 'string') return { invalid: 'model_text must be a string' };
    const text = capModelText(escapeModelText(parsed.model_text));
    if (text.length > 0) {
      try {
        result.model_text = guardedSafeText(text, 'model_text', guard);
      } catch {
        return { invalid: 'model_text failed the leak guard' };
      }
      result.model_text_label = MODEL_TEXT_LABEL;
    }
  }
  return result;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Calls the provider at most twice: one retry on invalid output (each attempt reserved and charged by the adapter),
 * then status 'failed'. A provider error (throw) fails immediately without a free retry. The request body is produced by
 * serializeSafe, so a view that would leak is never sent (status 'failed', failure 'leak_guard').
 */
export async function judgeWithRetry(caller: RawJudgeCaller, view: MaskedView, guard: LeakGuard): Promise<JudgeResult> {
  let body: string;
  try {
    body = serializeSafe(view, 'judge_request', guard);
  } catch {
    // LeakGuardError (or a not-ready guard): nothing is sent.
    return failedResult(caller.provider, caller.modelId, 'leak_guard');
  }
  if (utf8Bytes(body) > MAX_VIEW_BYTES) return failedResult(caller.provider, caller.modelId, 'oversize_view');

  let usage: JudgeUsage = { ...ZERO_USAGE };
  let estimated = false;
  let unknown = false;
  for (const attempt of [1, 2] as const) {
    let out: { output: unknown; usage: JudgeUsage; usage_estimated?: boolean };
    try {
      out = await caller.call({ view, body, attempt });
    } catch (error) {
      if (error instanceof ChargedProviderError) {
        usage = addUsage(usage, error.chargedUsage);
        estimated ||= error.usageEstimated;
        unknown ||= error.usageUnknown;
      }
      const failed = failedResult(caller.provider, caller.modelId, 'provider_error', usage);
      if (estimated) failed.usage_estimated = true;
      if (unknown) failed.usage_unknown = true;
      return failed;
    }
    usage = addUsage(usage, out.usage);
    estimated ||= out.usage_estimated === true;
    const v = validateJudgeOutput(out.output, view, { citationsRequired: caller.citationsRequired }, guard, {
      provider: caller.provider,
      modelId: caller.modelId,
      usage,
    });
    if (!isInvalid(v)) {
      if (estimated) v.usage_estimated = true;
      return v;
    }
  }
  const failed = failedResult(caller.provider, caller.modelId, 'invalid_output', usage);
  if (estimated) failed.usage_estimated = true;
  return failed;
}
