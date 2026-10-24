// Threshold loader and validator (Claude §2.5). config/thresholds.json ships as source "untuned-default" with
// judge_dismiss_enabled=false; M4 tuning overwrites it with "dev-tuned" (or records infeasible=true, dismissal disabled).

export interface Thresholds {
  source: 'untuned-default' | 'dev-tuned';
  judge_dismiss_enabled: boolean;
  t_dismiss: number;
  t_keep: number;
  target_recall: number;
  infeasible?: boolean;
}

export class ThresholdsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThresholdsError';
  }
}

const KNOWN_KEYS = new Set(['source', 'judge_dismiss_enabled', 't_dismiss', 't_keep', 'target_recall', 'infeasible', 'counts',
  'tuned_at', 'note', 'lineage']);
const LINEAGE_KEYS = new Set(['version', 'origin', 'method', 'studyHash', 'devPopulationHash', 'devCount', 'devReal',
  'operatingHash', 'thresholdHash']);

/** Approved metadata shape only. The study layer additionally verifies every hash/count against the frozen run. */
function validLineage(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lineage = value as Record<string, unknown>;
  if (Object.keys(lineage).some(key => !LINEAGE_KEYS.has(key))
    || lineage.version !== 1 || lineage.origin !== 'live' || lineage.method !== 'generative') return false;
  if (!['studyHash', 'devPopulationHash', 'operatingHash', 'thresholdHash'].every(key =>
    typeof lineage[key] === 'string' && /^[0-9a-f]{64}$/.test(lineage[key] as string))) return false;
  return Number.isSafeInteger(lineage.devCount) && (lineage.devCount as number) > 0
    && Number.isSafeInteger(lineage.devReal) && (lineage.devReal as number) >= 0
    && (lineage.devReal as number) <= (lineage.devCount as number);
}

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Validates and freezes thresholds. Throws ThresholdsError on anything invalid; never fills in defaults silently. */
export function loadThresholds(json: unknown): Thresholds {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new ThresholdsError('thresholds: expected an object');
  const j = json as Record<string, unknown>;
  for (const k of Object.keys(j)) if (!KNOWN_KEYS.has(k)) throw new ThresholdsError(`thresholds: unknown key ${k}`);
  if (j.source !== 'untuned-default' && j.source !== 'dev-tuned') {
    throw new ThresholdsError('thresholds: source must be "untuned-default" or "dev-tuned"');
  }
  if (j.lineage !== undefined && (j.source !== 'dev-tuned' || !validLineage(j.lineage))) {
    throw new ThresholdsError('thresholds: invalid live dev-tuning lineage metadata');
  }
  if (typeof j.judge_dismiss_enabled !== 'boolean') throw new ThresholdsError('thresholds: judge_dismiss_enabled must be a boolean');
  if (!finite(j.t_dismiss) || !finite(j.t_keep)) throw new ThresholdsError('thresholds: t_dismiss and t_keep must be finite numbers');
  if (!(j.t_dismiss >= 0 && j.t_dismiss < j.t_keep && j.t_keep <= 1)) {
    throw new ThresholdsError('thresholds: require 0 <= t_dismiss < t_keep <= 1');
  }
  if (!finite(j.target_recall) || !(j.target_recall > 0 && j.target_recall <= 1)) {
    throw new ThresholdsError('thresholds: target_recall must be a finite number in (0, 1]');
  }
  if (j.infeasible !== undefined && typeof j.infeasible !== 'boolean') throw new ThresholdsError('thresholds: infeasible must be a boolean');
  if (j.infeasible === true && j.judge_dismiss_enabled) {
    throw new ThresholdsError('thresholds: infeasible operating point must have judge_dismiss_enabled=false');
  }
  const t: Thresholds = {
    source: j.source,
    judge_dismiss_enabled: j.judge_dismiss_enabled,
    t_dismiss: j.t_dismiss,
    t_keep: j.t_keep,
    target_recall: j.target_recall,
  };
  if (j.infeasible !== undefined) t.infeasible = j.infeasible;
  return Object.freeze(t);
}

/** True only when thresholds explicitly allow the judge to suggest a dismissal. */
export function judgeDismissAllowed(t: Thresholds): boolean {
  return t.judge_dismiss_enabled === true && t.infeasible !== true;
}
