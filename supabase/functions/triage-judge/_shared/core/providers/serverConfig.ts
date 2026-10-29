import { validPrice } from '../ledger/prices.ts';
import type { PriceRow } from '../ledger/prices.ts';
export type LiveProviderId = 'anthropic' | 'openai_compatible' | 'typesafe';
export interface TypeSafeCalibration {
  source: 'dev-tuned';
  formulaVersion: 'typesafe-logistic-v1';
  fitId: string;
  minChoiceConfidence: number;
  maxInjectionProbability: number;
  coefficients: { intercept: number; real: number; placeholder: number; reference: number; test: number };
}
export interface ServerProviderConfig {
  provider: LiveProviderId;
  modelId: string;
  apiKey: string;
  endpoint: string;
  allowedOrigins: readonly string[];
  price: PriceRow;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxResponseBytes: number;
  typeSafeCalibration?: TypeSafeCalibration;
  semanticScreenEnabled?: boolean;
}
export interface ServerCaps { sessionUsd: number; userDayUsd: number; globalDayUsd: number }
export type ServerEnvironment = Readonly<Record<string, string | undefined>>;
function positive(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function loadServerCaps(env: ServerEnvironment): ServerCaps | null {
  const sessionUsd = positive(env.JUDGE_SESSION_USD);
  const userDayUsd = positive(env.JUDGE_DAILY_USER_USD);
  const globalDayUsd = positive(env.JUDGE_DAILY_GLOBAL_USD);
  return sessionUsd && userDayUsd && globalDayUsd ? { sessionUsd, userDayUsd, globalDayUsd } : null;
}
export function isLiveProvider(value: unknown): value is LiveProviderId {
  return value === 'anthropic' || value === 'openai_compatible' || value === 'typesafe';
}
/** Trusted server-only dev-fit material; no fitted parameters are shipped or inferred from held-out data. */
export function parseTypeSafeCalibration(raw: string): TypeSafeCalibration | null {
  try {
    const x: unknown = JSON.parse(raw);
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
    const c = x as Record<string, unknown>;
    if (Object.keys(c).length !== 7 || c.source !== 'dev-tuned' || c.formulaVersion !== 'typesafe-logistic-v1' ||
        typeof c.fitId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(c.fitId) ||
        typeof c.minChoiceConfidence !== 'number' || !Number.isFinite(c.minChoiceConfidence) || c.minChoiceConfidence <= 0 ||
        c.minChoiceConfidence > 1 || typeof c.maxInjectionProbability !== 'number' || !Number.isFinite(c.maxInjectionProbability) ||
        c.maxInjectionProbability < 0 || c.maxInjectionProbability >= 0.5 ||
        typeof c.coefficients !== 'object' || c.coefficients === null || Array.isArray(c.coefficients) ||
        c.verified !== true) return null;
    const coefficients = c.coefficients as Record<string, unknown>;
    const names = ['intercept', 'real', 'placeholder', 'reference', 'test'];
    if (Object.keys(coefficients).length !== names.length || !names.every((key) =>
      typeof coefficients[key] === 'number' && Number.isFinite(coefficients[key]) && Math.abs(coefficients[key] as number) <= 100)) return null;
    return { source: 'dev-tuned', formulaVersion: 'typesafe-logistic-v1', fitId: c.fitId,
      minChoiceConfidence: c.minChoiceConfidence, maxInjectionProbability: c.maxInjectionProbability,
      coefficients: coefficients as unknown as TypeSafeCalibration['coefficients'] };
  } catch { return null; }
}
/** Pure loader: caller supplies server environment. Never import this with credentials into a browser bundle. */
export function loadServerProviderConfig(env: ServerEnvironment, provider: LiveProviderId): ServerProviderConfig | null {
  if (env.JUDGE_LIVE_ENABLED !== 'true') return null;
  const prefix = provider === 'openai_compatible' ? 'OPENAI_COMPAT' : provider.toUpperCase();
  const read = (suffix: string): string | undefined => env[`${prefix}_${suffix}`];
  const apiKey = read('API_KEY');
  const modelId = read('MODEL_ID');
  if (!apiKey || !modelId || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(modelId)) return null;
  if (provider === 'typesafe' && modelId !== 'jev-1.13.0') return null;
  const input = read('INPUT_USD_PER_MILLION');
  const output = read('OUTPUT_USD_PER_MILLION');
  if (input === undefined || input.trim() === '' || output === undefined || output.trim() === '') return null;
  const price: PriceRow = { provider, modelId, inputUsdPerMillion: Number(input), outputUsdPerMillion: Number(output),
    asOf: read('PRICE_DATE') ?? '', verified: read('PRICE_VERIFIED') === 'true' };
  if (!validPrice(price)) return null;
  let typeSafeCalibration: TypeSafeCalibration | undefined;
  if (provider === 'typesafe' && read('CALIBRATION_JSON') !== undefined) {
    const parsed = parseTypeSafeCalibration(read('CALIBRATION_JSON')!);
    if (!parsed) return null;
    typeSafeCalibration = parsed;
  }
  let endpoint = provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.typesafe.ai/v1/systemone';
  let allowedOrigins: string[] = [new URL(endpoint).origin];
  if (provider === 'openai_compatible') {
    const base = read('BASE_URL');
    if (!base) return null;
    allowedOrigins = (read('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const url = new URL(base);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
          !allowedOrigins.includes(url.origin) || !/^\/v1\/?$/.test(url.pathname)) return null;
      endpoint = `${url.origin}/v1/chat/completions`;
    } catch { return null; }
  }
  return { provider, modelId, apiKey, endpoint, allowedOrigins, price, maxInputTokens: 32_768,
    maxOutputTokens: 512, timeoutMs: 15_000, maxResponseBytes: 65_536,
    semanticScreenEnabled: env.JUDGE_SEMANTIC_SCREEN_ENABLED === 'true',
    ...(typeSafeCalibration ? { typeSafeCalibration } : {}) };
}
