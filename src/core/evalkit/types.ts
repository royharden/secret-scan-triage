import type { Band, Finding } from '../finding.ts';
import type { JudgeResult, JudgeUsage } from '../judge/contract.ts';
import type { DescribedJudge, JudgeDescriptor } from '../providers/types.ts';
import type { Thresholds } from '../policy/thresholds.ts';
import type { LeakGuard } from '../safe.ts';
import type { JudgeCache } from './cache.ts';

export interface Sample {
  key: string;
  finding: Finding;
  label: boolean;
  group: string;
  trap?: string;
  split: 'dev' | 'heldout';
  emulation: { stopword: boolean; allowedPath: boolean; lowEntropy: boolean };
  /** Paired original candidate from a separate pipeline pass WITHOUT folder context; absent -> ablation not-run. */
  matchLineFinding?: Finding;
}
export type MethodId = 'scanner' | 'allowlist' | 'deterministic' | 'llm-only' | 'generative' | 'jev' | 'unsafe-path-dismiss' | 'matchline';
export type ObservationSource = 'deterministic' | 'scripted-mock' | 'live' | 'replay';
export interface Observation {
  sampleKey: string;
  band: Band;
  judge?: JudgeResult;
  source: ObservationSource;
  origin: 'deterministic' | 'scripted-mock' | 'live';
  guardBlocked?: boolean;
  measuredLatencyMs?: number;
  cachedLatencyMs?: number;
  /** Code-validated fresh-call receipt, independent of response safety. null means dispatched but accounting unknown. */
  attemptUsage?: JudgeUsage | null;
}
export interface Interval { low: number; high: number }
export interface Counts {
  n: number; real: number; negative: number; surfacedReal: number; surfacedNegative: number;
  reviewed: number; kept: number; keptReal: number;
}
export interface Metrics {
  n: number; real: number; negative: number; surfacedReal: number; surfacedNegative: number;
  recall: number | null; reduction: number | null; reviewRate: number | null; keepPrecision: number | null;
  recallInterval: Interval | null;
}
export interface BootstrapPlan { seed: number; groups: readonly string[]; draws: readonly (readonly number[])[] }
export interface BootstrapInterval { interval: Interval | null; valid: number; undefined: number }
export interface SweepPoint { dismissThreshold: number | null; metrics: Metrics }
export interface MatchedPoint { targetRecall: number; attainable: boolean; point: SweepPoint | null }
export interface MethodResult {
  method: MethodId;
  judge: JudgeDescriptor | null;
  configVersion: string;
  status: 'computed' | 'interface-replay' | 'not-run';
  reason?: string;
  observations: Observation[];
  metrics: Metrics | null;
  reductionInterval: BootstrapInterval | null;
  curve: SweepPoint[];
  matched: MatchedPoint[];
  usage: JudgeUsage | null;
  measuredLatencyMs: number | null;
  cachedLatencyMs: number | null;
}
export interface PairedComparison {
  left: MethodId; right: MethodId; targetRecall: number;
  attainable: boolean; difference: number | null; bootstrap: BootstrapInterval | null;
}
export interface EvaluationResult {
  version: 1; targetRecall: number;
  bootstrap: { seed: number; replicates: number };
  methods: MethodResult[];
  paired: PairedComparison[];
  promotion: { eligible: boolean; promoted: boolean; equivalenceEnabled: false; reasons: string[] };
}
export interface RunEvaluationInput {
  /** One split per run. Run dev first for live tuning, then evaluate the untouched held-out split once. */
  samples: readonly Sample[];
  guard: LeakGuard;
  thresholds: Thresholds;
  highPrecisionRules: readonly string[];
  judges: { generative?: DescribedJudge; jev?: DescribedJudge; llmOnly?: DescribedJudge };
  cache?: JudgeCache;
  targetRecall?: number;
  bootstrap?: BootstrapPlan;
  /** Caller may include all upstream config versions. Otherwise thresholds/high-precision settings are hashed. */
  configVersion?: string;
}
export interface TuneInput {
  samples: readonly Sample[];
  observations: readonly Observation[];
  method: 'generative' | 'jev';
  baseThresholds: Thresholds;
  highPrecisionRules: readonly string[];
  targetRecall: number;
}
export interface TuningResult { thresholds: Thresholds; feasible: boolean; reason?: string }
