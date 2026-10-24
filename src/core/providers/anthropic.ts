import { JUDGE_OUTPUT_SCHEMA } from '../judge/schema.ts';
import { PROMPT_TEMPLATE, renderPrompt } from '../judge/prompt.ts';
import type { ProviderProtocol } from './rawtransport.ts';
/** Response-only schema tool. No execution tools are available to the model. */
export const anthropicProtocol: ProviderProtocol = {
  citationsRequired: true,
  fingerprint: `${PROMPT_TEMPLATE}\n${JSON.stringify(JUDGE_OUTPUT_SCHEMA)}\nanthropic-response-tool-v1`,
  build(request, config) {
    const prompt = renderPrompt(request.body);
    return { model: config.modelId, max_tokens: config.maxOutputTokens, temperature: 0, system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      tools: [{ name: 'judge_response', description: 'Return the judgment as schema fields only.', input_schema: JUDGE_OUTPUT_SCHEMA }],
      tool_choice: { type: 'tool', name: 'judge_response', disable_parallel_tool_use: true } };
  },
  headers(config) { return { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }; },
  read(raw) {
    const content = raw.content;
    if (!Array.isArray(content)) throw new Error('');
    const tools = content.filter((x: unknown) => typeof x === 'object' && x !== null &&
      (x as Record<string, unknown>).type === 'tool_use' && (x as Record<string, unknown>).name === 'judge_response');
    if (tools.length !== 1 || raw.stop_reason !== 'tool_use') throw new Error('');
    const usage = (typeof raw.usage === 'object' && raw.usage !== null ? raw.usage : {}) as Record<string, unknown>;
    return { output: (tools[0] as Record<string, unknown>).input, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  },
};
