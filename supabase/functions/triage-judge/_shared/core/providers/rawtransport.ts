import { serializeSafe } from '../safe.ts';
import type { LeakGuard } from '../safe.ts';
import { ChargedProviderError, MAX_VIEW_BYTES, ZERO_USAGE } from '../judge/contract.ts';
import type { JudgeUsage, RawJudgeCaller, RawJudgeRequest } from '../judge/contract.ts';
import { sha256Hex, stableStringify } from '../judge/fingerprint.ts';
import { priceUsage, validPrice } from '../ledger/prices.ts';
import type { CallLedger, UsageReservation } from '../ledger/callledger.ts';
import type { ServerProviderConfig } from './serverConfig.ts';
export interface ProviderDependencies {
  guard: LeakGuard;
  ledger: CallLedger;
  requestId: string;
  payloadHash?: string;
  fetch?: typeof fetch;
}
export interface ProviderProtocol {
  citationsRequired: boolean;
  fingerprint: string;
  build(request: RawJudgeRequest, config: ServerProviderConfig): unknown;
  headers(config: ServerProviderConfig): Record<string, string>;
  read(raw: Record<string, unknown>, config: ServerProviderConfig): { output: unknown; inputTokens: unknown; outputTokens: unknown };
}
function positiveInteger(n: number, max: number): boolean { return Number.isSafeInteger(n) && n > 0 && n <= max; }
export function validProviderConfig(c: ServerProviderConfig): boolean {
  try {
    const url = new URL(c.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !c.allowedOrigins.includes(url.origin) || !c.apiKey || !c.modelId ||
        !validPrice(c.price) || c.price.provider !== c.provider || c.price.modelId !== c.modelId ||
        !positiveInteger(c.maxInputTokens, 131_072) || !positiveInteger(c.maxOutputTokens, 4096) ||
        !positiveInteger(c.timeoutMs, 60_000) || !positiveInteger(c.maxResponseBytes, 262_144)) return false;
    if (c.provider === 'anthropic') return c.endpoint === 'https://api.anthropic.com/v1/messages';
    if (c.provider === 'typesafe') return c.endpoint === 'https://api.typesafe.ai/v1/systemone' && c.modelId === 'jev-1.13.0';
    return c.provider === 'openai_compatible' && url.pathname === '/v1/chat/completions';
  } catch { return false; }
}
/** Bounded streaming read; Content-Length is only an early rejection, never the authority. No raw errors escape. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('');
  if (!response.body) throw new Error('');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('');
    return raw as Record<string, unknown>;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error('');
  } finally { reader.releaseLock(); }
}
export function createRawCaller(config: ServerProviderConfig, deps: ProviderDependencies, protocol: ProviderProtocol): RawJudgeCaller {
  if (!validProviderConfig(config)) throw new Error('');
  const transport = deps.fetch ?? globalThis.fetch;
  return {
    id: `${config.provider}:${config.modelId}`, provider: config.provider, modelId: config.modelId,
    citationsRequired: protocol.citationsRequired,
    async call(request) {
      if (request.attempt !== 1 && request.attempt !== 2) throw new Error('');
      const checkedView = serializeSafe(request.view, 'judge_request', deps.guard);
      if (checkedView !== request.body || new TextEncoder().encode(checkedView).byteLength > MAX_VIEW_BYTES) throw new Error('');
      const body = serializeSafe(protocol.build(request, config), 'judge_request', deps.guard);
      // Conservative input ceiling: >= serialized UTF-8 bytes plus reserved protocol overhead. Not a tokenizer claim.
      // Refuse a prompt too large for this ceiling instead of under-reserving. Activation must validate provider tokenization (D16).
      if (new TextEncoder().encode(body).byteLength + 4096 > config.maxInputTokens) throw new Error('');
      const fingerprint = await sha256Hex(stableStringify({ protocol: protocol.fingerprint,
        calibration: config.typeSafeCalibration ?? null }));
      const payloadHash = await sha256Hex(stableStringify({ binding: deps.payloadHash ?? null, body, fingerprint,
        provider: config.provider, modelId: config.modelId }));
      const estimateUsd = priceUsage(config.price, config.maxInputTokens, config.maxOutputTokens);
      let reservation: UsageReservation;
      try {
        reservation = await deps.ledger.reserve({ requestId: deps.requestId, attempt: request.attempt, payloadHash,
          provider: config.provider, modelId: config.modelId, units: 1, estimateUsd, promptFingerprint: fingerprint });
        if (!await deps.ledger.claim(reservation.usageId)) throw new Error('');
      } catch {
        // An existing/ambiguous reservation may already be dispatching or settled. Do not dispatch, count it again,
        // or claim a zero charge. Only the durable ledger can reconcile its actual usage.
        throw new ChargedProviderError(ZERO_USAGE, false, true);
      }
      const estimatedUsage: JudgeUsage = { calls: 1, inputTokens: config.maxInputTokens,
        outputTokens: config.maxOutputTokens, usd: estimateUsd };
      const controller = new AbortController();
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('')); }, config.timeoutMs);
      });
      try {
        const raw = await Promise.race([
          (async () => {
            const response = await transport(config.endpoint, { method: 'POST', headers: protocol.headers(config),
              body, redirect: 'error', signal: controller.signal });
            if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(''); }
            return readBoundedJson(response, config.maxResponseBytes);
          })(), deadline,
        ]);
        const parsed = protocol.read(raw, config);
        const input = parsed.inputTokens;
        const output = parsed.outputTokens;
        if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > config.maxInputTokens ||
            typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0 || output > config.maxOutputTokens) {
          await deps.ledger.settle(reservation.usageId, 'ambiguous');
          return { output: parsed.output, usage: estimatedUsage, usage_estimated: true };
        }
        const usage: JudgeUsage = { calls: 1, inputTokens: input, outputTokens: output, usd: priceUsage(config.price, input, output) };
        await deps.ledger.settle(reservation.usageId, 'settled', usage.usd);
        return { output: parsed.output, usage };
      } catch {
        // Once dispatched, transport failures may have reached the provider. Never refund or silently retry them.
        try { await deps.ledger.settle(reservation.usageId, timedOut ? 'ambiguous' : 'failed'); } catch { /* durable reservation stays charged */ }
        throw new ChargedProviderError(estimatedUsage);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        controller.abort();
      }
    },
  };
}
