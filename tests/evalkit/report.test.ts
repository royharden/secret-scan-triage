import { describe, expect, it } from 'vitest';
import { claim, resultsMarkdown, limitationsMarkdown } from '../../scripts/report.ts';
import type { ReportBundle } from '../../scripts/report.ts';
import { emulationFacts } from '../../scripts/data.ts';
import { parseReport } from '../../src/core/ingest/index.ts';
import { runPipeline } from '../../src/core/pipeline.ts';
import { createMockJudge } from '../../src/core/providers/mock.ts';
import { fakeLive, thresholds } from './helpers.ts';

function bundle(mode: 'live' | 'scripted-mock'): ReportBundle {
  const descriptor = mode === 'live' ? fakeLive(() => .9).descriptor : createMockJudge(26).descriptor;
  const tuning = mode === 'live' ? { version: 1 as const, origin: 'live' as const, method: 'generative' as const,
    studyHash: 'a'.repeat(64), devPopulationHash: 'b'.repeat(64), devCount: 10, devReal: 2,
    operatingHash: 'c'.repeat(64), thresholdHash: 'd'.repeat(64) } : null;
  return { dataset: { name: 'test synthetic set', seed: 1, generatorVersion: 'fixture', frozenAt: '2026-10-24T00:00:00Z', dev: { n: 10, real: 2 }, heldout: { n: 100, real: 10 } }, mode, generatedAt: '2026-10-24T00:00:00Z',
    operating: { studyHash: 'a'.repeat(64), operatingHash: 'c'.repeat(64), configVersion: 'fixture-config',
      thresholds: { ...thresholds, source: mode === 'live' ? 'dev-tuned' : 'untuned-default' },
      thresholdHash: 'd'.repeat(64), tuning, disposition: mode === 'live' ? 'primary-live' : 'interface-replay' },
    scoring: { version: 1, targetRecall: .98, bootstrap: { seed: 26, replicates: 2000 }, paired: [], promotion: { eligible: false, promoted: false, equivalenceEnabled: false, reasons: ['not earned'] }, methods: [{ method: 'generative', judge: descriptor, configVersion: 'fixture-config', status: mode === 'live' ? 'computed' : 'interface-replay', observations: [], metrics: { n: 100, real: 10, negative: 90, surfacedReal: 9, surfacedNegative: 45, recall: .9, reduction: .5, reviewRate: .5, keepPrecision: .9, recallInterval: { low: .6, high: .98 } }, reductionInterval: { interval: { low: .3, high: .7 }, valid: 2000, undefined: 0 }, curve: [], matched: [], usage: null, measuredLatencyMs: null, cachedLatencyMs: null }] } };
}
describe('one-object scorer reporting', () => {
  it('renders configured provider/model/adapter and operating lineage, including not-run and mock identities', () => {
    // what_bug_this_catches: readable tables dropped judge identity even though JSON/cache observations sometimes had it.
    const value = bundle('live');
    const gen = fakeLive(() => .9).descriptor, jev = fakeLive(() => .9, 'system-one').descriptor;
    value.scoring.methods.push({ ...value.scoring.methods[0], method: 'jev', judge: jev });
    value.scoring.methods.push({ ...value.scoring.methods[0], method: 'matchline', status: 'not-run', judge: gen, metrics: null });
    const rendered = resultsMarkdown(value);
    for (const descriptor of [gen, jev]) expect(rendered).toContain(`${descriptor.provider} / ${descriptor.modelId} / ${descriptor.id}`);
    expect(rendered).toContain('dev-tuned');
    expect(rendered).toContain('fixture-config');
    expect(rendered).toContain(value.operating.thresholdHash);
    expect(rendered).toContain('Guard-blocked / candidates');
    expect(resultsMarkdown(bundle('scripted-mock'))).toContain('scripted-mock; mock /');
    value.operating.disposition = 'exploratory-live';
    expect(claim(value)).toContain('Exploratory live repeat');
    expect(claim(value)).not.toContain('candidate recall was');
  });
  it('never turns scripted scores into a measured headline', () => {
    expect(claim(bundle('scripted-mock'))).toContain('Not yet measured');
    expect(resultsMarkdown(bundle('scripted-mock'))).toContain('interface-replay');
  });
  it('states achieved recall, real count and a target miss from the same result', () => {
    const value = bundle('live');
    expect(claim(value)).toContain('100 held-out candidates, 10 labelled real');
    expect(claim(value)).toContain('Recall MISSED');
    expect(claim(value)).toContain('90.00%');
    expect(limitationsMarkdown(value, [])).toContain(claim(value));
  });
  it('keeps emulation independent from app signals and labels on original metadata', async () => {
    // what_bug_this_catches: sanitized metadata must not break the original-candidate label join.
    const value = ['Qz7', 'Wp8', 'Km9', 'Tr2', 'Yx4', 'Vn6'].join('');
    const report = JSON.stringify([{ RuleID: 'generic-api-key', File: `docs/${value}.ts`, StartLine: 1, Secret: value, Match: value }]);
    const raw = parseReport(report, 'gitleaks').candidates[0];
    expect(emulationFacts(raw).allowedPath).toBe(true);
    const output = await runPipeline({ text: report, format: 'gitleaks', projectSalt: new Uint8Array(32).fill(26) });
    expect(output.sourceRecordIndices).toEqual([raw.recordIndex]);
    expect(output.findings[0].path).not.toContain(value);
  });
});
