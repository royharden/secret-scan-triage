import { describe, expect, it } from 'vitest';
import { estimateAudit } from '../../src/core/audit/estimate.ts';
import { auditSampleSize, createAuditCohort } from '../../src/core/audit/sampler.ts';
import { bindingFor, eventFor, scope } from './fixtures.ts';

describe('immutable seeded audit', () => {
  it('implements the minimum-five / five-percent formula, including empty and small populations', () => {
    // what_bug_this_catches: sampling five from fewer than five, or rounding the five-percent quota down.
    expect([0, 1, 4, 5, 20, 100, 101, 400].map(auditSampleSize)).toEqual([0, 1, 4, 5, 5, 5, 6, 20]);
    expect(() => auditSampleSize(-1)).toThrow();
    expect(() => auditSampleSize(2.5)).toThrow();
  });
  it('samples without replacement reproducibly despite queue reorder and freezes copied bindings', () => {
    // what_bug_this_catches: re-render changes the sample, duplicates consume slots, or mutable rows change the cohort.
    const bindings = Array.from({ length: 100 }, (_, i) => bindingFor(`finding-${i}`));
    const first = createAuditCohort('run-a', bindings, 36);
    expect(createAuditCohort('run-a', bindings.slice().reverse(), 36)).toEqual(first);
    expect(new Set(first.members.map((member) => member.findingId)).size).toBe(5);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.members)).toBe(true);
    expect(first.members.every(Object.isFrozen)).toBe(true);
    const picked = first.members[0];
    const original = bindings.find((binding) => binding.findingId === picked.findingId)!;
    original.valueTag = 'c'.repeat(64);
    expect(picked.valueTag).toBe('b'.repeat(64));
    expect(Object.keys(picked).sort()).toEqual(['contentHash', 'findingId', 'valueTag']);
    expect(createAuditCohort('empty', [], 36).members).toHaveLength(0);
    expect(createAuditCohort('duplicates', [bindingFor(), bindingFor()], 36).populationSize).toBe(1);
  });
  it('excludes skip/unanswered rows from the error estimate and reports coverage plus Wilson uncertainty', () => {
    // what_bug_this_catches: skipped audits diluting the false-dismissal rate or fabricated zero-error certainty.
    const cohort = createAuditCohort('run-a', ['a', 'b', 'c'].map(bindingFor), 51);
    const events = cohort.members.map((member, i) => eventFor({ ...member, eventId: String(i + 1),
      isAudit: true, auditCohortId: cohort.id, decision: i === 0 ? 'real' : i === 1 ? 'dismiss_approved' : 'skip' }));
    const result = estimateAudit(cohort, events, scope);
    expect(result).toMatchObject({ sampled: 3, reviewed: 2, wronglyHidden: 1, unreviewed: 1, coverage: 2 / 3, rate: 0.5 });
    expect(result.wilson95?.lower).toBeCloseTo(0.09453, 4);
    expect(result.wilson95?.upper).toBeCloseTo(0.90547, 4);
    expect(estimateAudit(cohort, [], scope)).toMatchObject({ reviewed: 0, rate: null, wilson95: null, coverage: 0 });
    expect(estimateAudit(createAuditCohort('empty', [], 1), [], scope)).toMatchObject({ sampled: 0, coverage: null, rate: null, wilson95: null });
  });
  it('uses latest responses and refuses other owners, cohorts, or changed bindings', () => {
    // what_bug_this_catches: reversal is ignored or a response from another run/project enters this cohort's estimate.
    const cohort = createAuditCohort('run-a', [bindingFor()], 9);
    const reviewed = eventFor({ isAudit: true, auditCohortId: cohort.id, decision: 'real', localSeq: 1 });
    const skipped = { ...reviewed, decision: 'skip' as const, eventId: '2', localSeq: 2 };
    expect(estimateAudit(cohort, [reviewed, skipped], scope).reviewed).toBe(0);
    for (const over of [{ ownerId: 'other' }, { projectKey: 'other' }, { valueTag: 'c'.repeat(64) },
      { contentHash: 'd'.repeat(64) }, { auditCohortId: 'other-cohort' }, { isAudit: false }]) {
      expect(estimateAudit(cohort, [{ ...reviewed, ...over }], scope).reviewed).toBe(0);
    }
  });
});
