import { JUDGE_OUTPUT_SCHEMA } from '../judge/schema.ts';
import { PROMPT_TEMPLATE, renderPrompt } from '../judge/prompt.ts';
import type { ProviderProtocol } from './rawtransport.ts';
// Strict endpoints require every property in required; nullable optional fields retain core semantics.
export const OPENAI_RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['p_real', 'reason_code', 'cited_lines', 'model_text'],
  properties: { ...JUDGE_OUTPUT_SCHEMA.properties,
    cited_lines: { anyOf: [JUDGE_OUTPUT_SCHEMA.properties.cited_lines, { type: 'null' }] },
    model_text: { anyOf: [JUDGE_OUTPUT_SCHEMA.properties.model_text, { type: 'null' }] } },
};
export const openaiCompatibleProtocol: ProviderProtocol = {
  citationsRequired: true,
  fingerprint: `${PROMPT_TEMPLATE}\n${JSON.stringify(OPENAI_RESPONSE_SCHEMA)}\nopenai-json-schema-v1`,
  build(request, config) {
    const prompt = renderPrompt(request.body);
    return { model: config.modelId, max_tokens: config.maxOutputTokens, temperature: 0,
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      response_format: { type: 'json_schema', json_schema: { name: 'judge_response', strict: true, schema: OPENAI_RESPONSE_SCHEMA } } };
  },
  headers(config) { return { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` }; },
  read(raw) {
    const choices = raw.choices;
    if (!Array.isArray(choices) || choices.length !== 1) throw new Error('');
    const choice = choices[0] as Record<string, unknown>;
    if (!choice || choice.finish_reason !== 'stop' || typeof choice.message !== 'object' || choice.message === null) throw new Error('');
    const message = choice.message as Record<string, unknown>;
    if (message.refusal || typeof message.content !== 'string') throw new Error('');
    const usage = (typeof raw.usage === 'object' && raw.usage !== null ? raw.usage : {}) as Record<string, unknown>;
    return { output: message.content, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
  },
};
