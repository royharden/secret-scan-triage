import type { LeakGuard } from '../../src/core/safe.ts';
import { unsafeMarkSafe } from '../../src/core/safe.ts';
import type { MaskedView } from '../../src/core/judge/contract.ts';
import type { ServerProviderConfig } from '../../src/core/providers/serverConfig.ts';
export const guard: LeakGuard = { ready: true, check() {}, exemptDigests: () => 0 };
export function view(): MaskedView {
  return { findingId: 'candidate-0', ruleId: 'generic-key', pathClass: 'source', basename: unsafeMarkSafe('app.ts'),
    maskedLine: unsafeMarkSafe('key = "********"'), maskedWindow: [{ lineId: 'L0', text: unsafeMarkSafe('key = "********"') }],
    lengthBucket: 'm', entropyBucket: 'high', charClass: 'alnum', signalBuckets: [], scannerVerified: false };
}
/** Invented test-only model and prices, NEVER activation defaults or measured provider facts. */
export function config(): ServerProviderConfig {
  return { provider: 'anthropic', modelId: 'test-model', apiKey: 'test-placeholder',
    endpoint: 'https://api.anthropic.com/v1/messages', allowedOrigins: ['https://api.anthropic.com'],
    price: { provider: 'anthropic', modelId: 'test-model', inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      asOf: '2026-10-24', verified: true }, maxInputTokens: 32_768, maxOutputTokens: 512, timeoutMs: 100,
    maxResponseBytes: 65_536 };
}
export function response(output: unknown, input = 100, out = 20): Response {
  return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'judge_response', input: output }],
    stop_reason: 'tool_use', usage: { input_tokens: input, output_tokens: out } }), { headers: { 'content-type': 'application/json' } });
}
export const judgment = { p_real: 0.7, reason_code: 'looks_real', cited_lines: ['L0'] };
