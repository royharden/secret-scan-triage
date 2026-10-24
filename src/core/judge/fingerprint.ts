// Prompt fingerprint = SHA-256 hex of (prompt template + judge output schema version + schema body).
// Web Crypto (crypto.subtle) is available in browsers, workers, Deno and Node 24.
import { PROMPT_TEMPLATE } from './prompt.ts';
import { JUDGE_OUTPUT_SCHEMA, JUDGE_SCHEMA_VERSION } from './schema.ts';

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest);
}

/** Deterministic JSON with sorted object keys (so key order never changes the fingerprint). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function fingerprintOf(template: string, schemaVersion: string, schema: unknown): Promise<string> {
  return sha256Hex(`${template}\n---schema:${schemaVersion}---\n${stableStringify(schema)}`);
}

/** Fingerprint of the shipped prompt + schema. 64 lowercase hex chars. */
export function promptFingerprint(): Promise<string> {
  return fingerprintOf(PROMPT_TEMPLATE, JUDGE_SCHEMA_VERSION, JUDGE_OUTPUT_SCHEMA);
}
