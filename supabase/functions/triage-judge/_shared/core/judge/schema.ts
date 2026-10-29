// JSON schemas for the judge output and the masked views (contract tests, provider structured-output definitions).
// Conditional rules the schema cannot express (citations required for generative adapters, citations inside the
// supplied window, leak-guard re-check of free text) are enforced in validate.ts.
import { MAX_MODEL_TEXT_CHARS, REASON_CODES } from './contract.ts';

export const JUDGE_SCHEMA_VERSION = 'judge-output-v1';
export const MASKED_VIEW_SCHEMA_VERSION = 'masked-view-v1';

export const LINE_ID_PATTERN = '^L(?:0|[+-][1-9][0-9]*)$';
export const MAX_CITED_LINES = 7;

export const JUDGE_OUTPUT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: JUDGE_SCHEMA_VERSION,
  type: 'object',
  additionalProperties: false,
  required: ['p_real', 'reason_code'],
  properties: {
    p_real: { type: 'number', minimum: 0, maximum: 1 },
    reason_code: { type: 'string', enum: [...REASON_CODES] },
    cited_lines: {
      type: 'array',
      items: { type: 'string', pattern: LINE_ID_PATTERN },
      maxItems: MAX_CITED_LINES,
      uniqueItems: true,
    },
    model_text: { type: 'string', maxLength: MAX_MODEL_TEXT_CHARS },
  },
});

const MASKED_LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lineId', 'text'],
  properties: { lineId: { type: 'string', pattern: LINE_ID_PATTERN }, text: { type: 'string' } },
};

export const MASKED_VIEW_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: MASKED_VIEW_SCHEMA_VERSION,
  type: 'object',
  additionalProperties: false,
  required: ['findingId', 'ruleId', 'pathClass', 'basename', 'maskedLine', 'maskedWindow', 'lengthBucket', 'entropyBucket',
    'charClass', 'signalBuckets', 'scannerVerified'],
  properties: {
    findingId: { type: 'string' },
    ruleId: { type: 'string' },
    pathClass: { type: 'string', enum: ['test', 'fixture', 'docs', 'lockfile', 'source', 'config', 'other'] },
    basename: { type: 'string' },
    maskedLine: { type: 'string' },
    maskedWindow: { type: 'array', items: MASKED_LINE_SCHEMA, maxItems: 7 },
    lengthBucket: { type: 'string', enum: ['xs', 's', 'm', 'l', 'xl'] },
    entropyBucket: { type: 'string', enum: ['low', 'mid', 'high'] },
    charClass: { type: 'string', enum: ['hex', 'base64', 'base64url', 'alnum', 'digits', 'mixed', 'pem'] },
    signalBuckets: { type: 'array', items: { type: 'string', pattern: '^S-[RF][0-9]{1,2}:(?:real|fp):(?:decisive|strong|weak)$' } },
    scannerVerified: { type: 'boolean' },
  },
});
