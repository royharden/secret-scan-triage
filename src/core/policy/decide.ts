// Two-stage policy in code (Claude §2.5, merged PLAN P8). Pure functions; the model never decides a band on its own.
//
// Stage 1 resolveDeterministic(signals, flags):
//   decisive real (S-R1)                         -> keep        (nothing overrides verified: T13, T18)
//   injection | malformed evidence | unmaskable  -> review
//   decisive fp on span AND strong real on span:
//       decisive fp is S-F1 exact sentinel       -> dismiss (suggested)   (T01)
//       else                                     -> review     (unresolved conflict)
//   decisive fp on span                          -> dismiss (suggested)
//   else                                         -> unresolved (eligible for the judge)
// Stage 2 decideWithJudge(unresolved finding, judgeResult, thresholds, highPrecisionRules):
//   not_requested / failed / cannot_tell / non-finite p_real -> review
//   high-precision rule                          -> keep if p_real >= t_keep else review (judge alone never dismisses)
//   judge_dismiss_enabled & p_real <= t_dismiss & no strong real -> dismiss (suggested)
//   p_real >= t_keep                             -> keep
//   else                                         -> review
//   Weak FP signals (incl. S-F11 path, downgrade only) may move keep -> review when no strong real backs the keep;
//   they never move review -> dismiss.
// Every "dismiss" is a suggestion; only a human approval creates a dismissal ruling.
import type { Band, Finding, Flags, Signal, Stage1Outcome } from '../finding.ts';
import { failedResult } from '../judge/contract.ts';
import type { JudgeResult } from '../judge/contract.ts';
import { judgeDismissAllowed } from './thresholds.ts';
import type { Thresholds } from './thresholds.ts';

export { loadThresholds, ThresholdsError, judgeDismissAllowed } from './thresholds.ts';
export type { Thresholds } from './thresholds.ts';

export interface Stage1Result {
  outcome: Stage1Outcome;
  reasons: string[];
}

export interface Decision {
  band: Band;
  stage: 1 | 2;
  reasons: string[];
}

const SUGGESTION = 'suggested dismissal only: a human approval is required';

function label(s: Signal): string {
  return `${s.id} ${s.name}`;
}

export function decisiveReal(signals: ReadonlyArray<Signal>): Signal[] {
  return signals.filter((s) => s.direction === 'real' && s.strength === 'decisive');
}
export function strongReal(signals: ReadonlyArray<Signal>): Signal[] {
  return signals.filter((s) => s.direction === 'real' && s.strength === 'strong');
}
export function decisiveFp(signals: ReadonlyArray<Signal>): Signal[] {
  return signals.filter((s) => s.direction === 'fp' && s.strength === 'decisive');
}
export function weakFp(signals: ReadonlyArray<Signal>): Signal[] {
  return signals.filter((s) => s.direction === 'fp' && (s.strength === 'weak' || s.downgradeOnly === true));
}
/** Any real-direction signal of strong or decisive strength. */
export function hasStrongReal(signals: ReadonlyArray<Signal>): boolean {
  return signals.some((s) => s.direction === 'real' && (s.strength === 'strong' || s.strength === 'decisive'));
}

/** Stage 1 with human-readable reasons for the UI. */
export function resolveDeterministicDetailed(signals: ReadonlyArray<Signal>, flags: Flags): Stage1Result {
  const dr = decisiveReal(signals);
  if (dr.length > 0) {
    return { outcome: 'keep', reasons: [`${dr.map(label).join(', ')}: scanner-verified; nothing overrides verified`] };
  }
  const flagReasons: string[] = [];
  if (flags.injection) flagReasons.push('screen.injection: directive-like text near the finding (untrusted, never evidence)');
  if (flags.malformedEvidence) flagReasons.push('malformed evidence: the finding could not be bound to its span');
  if (flags.unmaskableContext) flagReasons.push('unmaskable context: a context line was omitted because it could not be masked');
  if (flagReasons.length > 0) return { outcome: 'review', reasons: flagReasons };

  const dfp = decisiveFp(signals);
  const sr = strongReal(signals);
  if (dfp.length > 0 && sr.length > 0) {
    const sentinel = dfp.find((s) => s.id === 'S-F1');
    if (sentinel) {
      return {
        outcome: 'dismiss',
        reasons: [`${label(sentinel)}: exact documented example value; resolves conflict with ${sr.map(label).join(', ')}`, SUGGESTION],
      };
    }
    return {
      outcome: 'review',
      reasons: [`conflict: ${dfp.map(label).join(', ')} vs ${sr.map(label).join(', ')}; only an exact documented sentinel resolves it`],
    };
  }
  if (dfp.length > 0) return { outcome: 'dismiss', reasons: [`${dfp.map(label).join(', ')}: decisive proof on the finding's span`, SUGGESTION] };
  return { outcome: 'unresolved', reasons: ['no decisive deterministic outcome; eligible for the judge'] };
}

export function resolveDeterministic(signals: ReadonlyArray<Signal>, flags: Flags): Stage1Outcome {
  return resolveDeterministicDetailed(signals, flags).outcome;
}

/** True when stage 1 leaves the finding unresolved, i.e. the only case in which a judge may be asked. */
export function needsJudge(f: Finding): boolean {
  return resolveDeterministic(f.signals, f.flags) === 'unresolved';
}

function inHighPrecision(ruleId: string, hp: ReadonlyArray<string>): boolean {
  const r = ruleId.toLowerCase();
  return hp.some((h) => h.toLowerCase() === r);
}

/** Stage 2 with reasons. Defensive: re-applies the verified and flag guards so it is safe on any finding. */
export function decideWithJudgeDetailed(
  f: Finding,
  j: JudgeResult | null,
  t: Thresholds,
  highPrecisionRules: ReadonlyArray<string>,
): { band: Band; reasons: string[] } {
  const signals = f.signals;
  if (decisiveReal(signals).length > 0) return { band: 'keep', reasons: ['scanner-verified; nothing overrides verified'] };
  if (f.flags.injection || f.flags.malformedEvidence || f.flags.unmaskableContext) {
    return { band: 'review', reasons: ['flagged finding: judge output not used'] };
  }
  if (j === null || j.status === 'not_requested') {
    return { band: 'review', reasons: ['judge not requested (offline, no consent or no provider)'] };
  }
  if (j.status === 'failed') {
    return { band: 'review', reasons: ['judge failed (invalid output after one retry, provider error, cap or timeout)'] };
  }
  if (j.reason_code === 'cannot_tell') return { band: 'review', reasons: ['judge: cannot_tell'] };
  const p = j.p_real;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
    return { band: 'review', reasons: ['judge p_real missing or out of range'] };
  }
  const pTxt = `p_real ${p.toFixed(2)}`;

  let band: Band;
  const reasons: string[] = [];
  if (inHighPrecision(f.ruleId, highPrecisionRules)) {
    band = p >= t.t_keep ? 'keep' : 'review';
    reasons.push(`high-precision rule ${f.ruleId}: judge alone never dismisses (${pTxt}, t_keep ${t.t_keep})`);
  } else if (judgeDismissAllowed(t) && p <= t.t_dismiss && !hasStrongReal(signals)) {
    return { band: 'dismiss', reasons: [`judge ${j.reason_code}, ${pTxt} <= t_dismiss ${t.t_dismiss}; no strong real signal`, SUGGESTION] };
  } else if (p >= t.t_keep) {
    band = 'keep';
    reasons.push(`judge ${j.reason_code}, ${pTxt} >= t_keep ${t.t_keep}`);
  } else {
    band = 'review';
    if (!judgeDismissAllowed(t) && p <= t.t_dismiss) {
      reasons.push(`judge dismissal disabled (thresholds ${t.source}${t.infeasible ? ', infeasible' : ''}); ${pTxt}`);
    } else if (p <= t.t_dismiss && hasStrongReal(signals)) {
      reasons.push(`${pTxt} but strong real signal present (${strongReal(signals).map(label).join(', ')}): never dismissed`);
    } else {
      reasons.push(`judge ${j.reason_code}, ${pTxt} between thresholds`);
    }
  }

  if (band === 'keep' && !hasStrongReal(signals)) {
    const weak = weakFp(signals);
    if (weak.length > 0) {
      band = 'review';
      reasons.push(`downgraded keep -> review by weak signal(s) ${weak.map(label).join(', ')}`);
    }
  }
  return { band, reasons };
}

export function decideWithJudge(
  f: Finding,
  j: JudgeResult | null,
  t: Thresholds,
  highPrecisionRules: ReadonlyArray<string>,
): Band {
  return decideWithJudgeDetailed(f, j, t, highPrecisionRules).band;
}

/** Full decision. Stage 1 never needs a judge result; `j` is only consulted when stage 1 is unresolved. */
export function decide(
  f: Finding,
  j: JudgeResult | null,
  t: Thresholds,
  highPrecisionRules: ReadonlyArray<string>,
): Decision {
  const s1 = resolveDeterministicDetailed(f.signals, f.flags);
  if (s1.outcome !== 'unresolved') return { band: s1.outcome, stage: 1, reasons: s1.reasons };
  const s2 = decideWithJudgeDetailed(f, j, t, highPrecisionRules);
  return { band: s2.band, stage: 2, reasons: [...s1.reasons, ...s2.reasons] };
}

/**
 * Orchestration helper: calls `requestJudge` ONLY when stage 1 is unresolved. Pass null when offline / no consent; the
 * finding then lands in review with "judge not requested". A throwing judge is treated as a failed judge (review).
 */
export async function triage(
  f: Finding,
  requestJudge: ((f: Finding) => Promise<JudgeResult>) | null,
  t: Thresholds,
  highPrecisionRules: ReadonlyArray<string>,
): Promise<Decision & { judge: JudgeResult | null }> {
  if (!needsJudge(f)) return { ...decide(f, null, t, highPrecisionRules), judge: null };
  if (requestJudge === null) return { ...decide(f, null, t, highPrecisionRules), judge: null };
  let j: JudgeResult;
  try {
    j = await requestJudge(f);
  } catch {
    j = failedResult('unknown', 'unknown', 'provider_error');
  }
  return { ...decide(f, j, t, highPrecisionRules), judge: j };
}
