// Pure in-memory cache contract. Persistence belongs to the caller and must use entries(guard), never internal Maps.
import { serializeSafe } from '../safe.ts';
import type { LeakGuard } from '../safe.ts';
import { promptFingerprint, sha256Hex, stableStringify } from '../judge/fingerprint.ts';
import { JUDGE_SCHEMA_VERSION, MASKED_VIEW_SCHEMA_VERSION } from '../judge/schema.ts';
import { isReasonCode } from '../judge/contract.ts';
import type { JudgeResult, MaskedView } from '../judge/contract.ts';
import type { JudgeDescriptor, JudgeKind } from '../providers/types.ts';

export interface CacheIdentity {
  key: string;
  provider: string;
  modelId: string;
  kind: JudgeKind;
  adapterVersion: string;
  configVersion: string;
  schemaVersion: string;
  promptFingerprint: string;
  maskedPromptHash: string;
}
export interface CacheEntry {
  identity: CacheIdentity;
  result: JudgeResult;
  source: 'scripted-mock' | 'live' | 'replay';
  origin: 'scripted-mock' | 'live';
  measuredLatencyMs: number | null;
  createdAt: string;
}
export async function createCacheIdentity(view: MaskedView, descriptor: JudgeDescriptor, configVersion: string, guard: LeakGuard): Promise<CacheIdentity> {
  serializeSafe(view, 'judge_request', guard);
  const canonical = stableStringify(view);
  guard.check(canonical, 'cache');
  const fields = {
    provider: descriptor.provider, modelId: descriptor.modelId, kind: descriptor.kind,
    adapterVersion: descriptor.id, configVersion,
    schemaVersion: `${JUDGE_SCHEMA_VERSION}/${MASKED_VIEW_SCHEMA_VERSION}`,
    promptFingerprint: await promptFingerprint(), maskedPromptHash: await sha256Hex(canonical),
  };
  const identity = { key: await sha256Hex(stableStringify(fields)), ...fields };
  serializeSafe(identity, 'cache', guard);
  return identity;
}
function nonnegative(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n) && n >= 0; }
async function validated(entry: CacheEntry, guard: LeakGuard): Promise<CacheEntry> {
  const parsed = JSON.parse(serializeSafe(entry, 'cache', guard)) as CacheEntry;
  const identity = parsed.identity;
  if (!identity || !parsed.result) throw new Error('Invalid cache entry.');
  for (const key of ['key', 'provider', 'modelId', 'kind', 'adapterVersion', 'configVersion', 'schemaVersion', 'promptFingerprint', 'maskedPromptHash'] as const) if (typeof identity[key] !== 'string' || !identity[key]) throw new Error('Invalid cache identity.');
  const { key, ...fields } = identity;
  if (key !== await sha256Hex(stableStringify(fields))) throw new Error('Cache identity mismatch.');
  if (![identity.key, identity.promptFingerprint, identity.maskedPromptHash].every((hex) => /^[0-9a-f]{64}$/.test(hex)) || identity.schemaVersion !== `${JUDGE_SCHEMA_VERSION}/${MASKED_VIEW_SCHEMA_VERSION}` || identity.promptFingerprint !== await promptFingerprint()) throw new Error('Cache schema/prompt version mismatch.');
  const expectedOrigin = identity.kind === 'scripted-mock' ? 'scripted-mock' : 'live';
  if (!['scripted-mock', 'generative-llm', 'system-one'].includes(identity.kind) || parsed.origin !== expectedOrigin || !['scripted-mock', 'live', 'replay'].includes(parsed.source)) throw new Error('Invalid cache provenance.');
  if (parsed.source !== 'replay' && parsed.source !== parsed.origin) throw new Error('Cache origin mismatch.');
  const result = parsed.result;
  if (result.status !== 'ok' || !nonnegative(result.p_real) || result.p_real > 1 || !isReasonCode(result.reason_code) || result.provider !== identity.provider || result.modelId !== identity.modelId) throw new Error('Invalid cached judge result.');
  if (!result.usage || !Object.values(result.usage).every(nonnegative) || ['calls', 'inputTokens', 'outputTokens', 'usd'].some((k) => !nonnegative(result.usage[k as keyof typeof result.usage]))) throw new Error('Invalid cached usage.');
  if (parsed.origin === 'scripted-mock' && (parsed.measuredLatencyMs !== null || Object.values(result.usage).some((n) => n !== 0))) throw new Error('Mock measurement is forbidden.');
  if (parsed.measuredLatencyMs !== null && !nonnegative(parsed.measuredLatencyMs)) throw new Error('Invalid cached latency.');
  if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error('Invalid cache timestamp.');
  return parsed;
}

export class JudgeCache {
  private values = new Map<string, string>();
  private guard?: LeakGuard;

  async get(identity: CacheIdentity, guard: LeakGuard): Promise<CacheEntry | undefined> {
    this.guard = guard;
    serializeSafe(identity, 'cache', guard);
    const json = this.values.get(identity.key);
    if (json === undefined) return undefined;
    const value = await validated(JSON.parse(json) as CacheEntry, guard);
    if (stableStringify(value.identity) !== stableStringify(identity)) throw new Error('Cache request mismatch.');
    return value;
  }
  async put(entry: CacheEntry, guard: LeakGuard): Promise<void> {
    const value = await validated(entry, guard);
    this.guard = guard;
    this.values.set(value.identity.key, serializeSafe(value, 'cache', guard));
  }
  async importEntries(entries: readonly unknown[], guard: LeakGuard): Promise<void> {
    if (!Array.isArray(entries)) throw new Error('Invalid cache collection.');
    const staged: CacheEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const value = await validated(entry as CacheEntry, guard);
      if (seen.has(value.identity.key)) throw new Error('Duplicate cache identity.');
      seen.add(value.identity.key);
      staged.push({ ...value, source: 'replay' }); // Preserve actual origin and original measured latency.
    }
    this.guard = guard;
    for (const value of staged) this.values.set(value.identity.key, serializeSafe(value, 'cache', guard));
  }
  entries(guard: LeakGuard | undefined = this.guard): CacheEntry[] {
    const out: CacheEntry[] = [];
    for (const json of this.values.values()) {
      if (!guard) throw new Error('Ready guard required.');
      // Identity/provenance were checked on insertion. Recheck ALL keys/leaves against the current run before export.
      out.push(JSON.parse(serializeSafe(JSON.parse(json), 'cache', guard)) as CacheEntry);
    }
    return out;
  }
}

export function createMemoryJudgeCache(): JudgeCache { return new JudgeCache(); }
