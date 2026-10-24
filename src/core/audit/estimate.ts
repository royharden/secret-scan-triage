import { sameBinding } from '../rulings/binding.ts';
import { latestRulings } from '../rulings/replay.ts';
import type { OwnerProject, RulingEvent } from '../rulings/types.ts';
import type { AuditCohort } from './sampler.ts';

export interface AuditEstimate {
  sampled: number;
  reviewed: number;
  wronglyHidden: number;
  unreviewed: number;
  coverage: number | null;
  rate: number | null;
  wilson95: { lower: number; upper: number } | null;
}
/** Describes reviewed sample responses only; never changes automated evaluation metrics. */
export function estimateAudit(cohort: AuditCohort, events: readonly RulingEvent[], scope: OwnerProject): AuditEstimate {
  const latest = latestRulings(events, scope);
  let reviewed = 0;
  let wronglyHidden = 0;
  for (const member of cohort.members) {
    const event = latest.get(member.findingId);
    if (event === undefined || !sameBinding(member, event) || !event.isAudit || event.auditCohortId !== cohort.id || event.decision === 'skip') continue;
    reviewed++;
    if (event.decision === 'real') wronglyHidden++;
  }
  const sampled = cohort.members.length;
  let wilson95: AuditEstimate['wilson95'] = null;
  if (reviewed > 0) {
    const z = 1.959963984540054;
    const z2 = z * z;
    const p = wronglyHidden / reviewed;
    const divisor = 1 + z2 / reviewed;
    const center = (p + z2 / (2 * reviewed)) / divisor;
    const radius = z * Math.sqrt(p * (1 - p) / reviewed + z2 / (4 * reviewed * reviewed)) / divisor;
    wilson95 = { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
  }
  return {
    sampled, reviewed, wronglyHidden, unreviewed: sampled - reviewed,
    coverage: sampled === 0 ? null : reviewed / sampled,
    rate: reviewed === 0 ? null : wronglyHidden / reviewed, wilson95,
  };
}
