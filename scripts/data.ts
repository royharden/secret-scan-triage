// Node evaluation adapter only. Raw values never become report, cache, ledger or browser payloads.
import { generateSynthetic } from '../src/core/synth/generator.ts';
import type { SynthManifest } from '../src/core/synth/generator.ts';
import { labelKey } from '../src/core/synth/emit.ts';
import { parseReport } from '../src/core/ingest/index.ts';
import type { RawCandidate } from '../src/core/finding.ts';
import { runPipeline, pipelineConfig } from '../src/core/pipeline.ts';
import { buildLeakGuard, createSessionSalt } from '../src/core/mask/leakIndex.ts';
import { keptPrefixFor } from '../src/core/mask/mask.ts';
import { shannonEntropy } from '../src/core/features/entropy.ts';
import type { Sample } from '../src/core/evalkit/types.ts';
import type { LeakGuard } from '../src/core/safe.ts';

/** Deliberately independent scanner-control subset; never derives its decision from application signals. */
export function emulationFacts(raw: RawCandidate): Sample['emulation'] {
  const value = raw.rawValue;
  const hex = /^[0-9a-f]+$/i.test(value);
  return {
    stopword: /(?:changeme|example|dummy|redacted|your[_-]?(?:api[_-]?)?key)/i.test(value),
    allowedPath: /(?:^|[\\/])(?:tests?|fixtures?|docs?)(?:[\\/]|$)/i.test(raw.path),
    lowEntropy: shannonEntropy(value) < (hex ? 3 : 3.5),
  };
}
export interface LoadedSynthetic { samples: Sample[]; guard: LeakGuard; manifest: SynthManifest }
export async function loadSynthetic(seed = 26024, size = 400, identitySalt?: Uint8Array): Promise<LoadedSynthetic> {
  const generated = generateSynthetic({ seed, size });
  const prefixes = pipelineConfig().prefixes;
  const values = [...generated.rawOracle.reportedValues, ...generated.rawOracle.unreportedValues];
  const kept = values.flatMap(value => { const prefix = keptPrefixFor(value, prefixes); return prefix ? [{ value, prefix }] : []; });
  const guard = buildLeakGuard(values, kept, createSessionSalt());
  const projectSalt = identitySalt ?? createSessionSalt();
  const samples: Sample[] = [];
  const valueGroups = new Map<string, string>();
  for (const format of ['gitleaks', 'trufflehog'] as const) {
    const text = format === 'gitleaks' ? generated.gitleaksJson : generated.trufflehogNdjson;
    const parsed = parseReport(text, format);
    const metadata = new Map<number, Omit<Sample, 'finding'>>();
    for (const raw of parsed.candidates) {
      // Join on ORIGINAL candidate metadata before sanitization; a masked path/rule must never lose a denominator.
      const label = generated.labels[labelKey(format, raw.path, raw.line, raw.ruleId)];
      if (!label) throw new Error('');
      const previousGroup = valueGroups.get(raw.rawValue);
      if (previousGroup !== undefined && previousGroup !== label.group) throw new Error('');
      valueGroups.set(raw.rawValue, label.group);
      const split = generated.manifest.splits[label.group];
      if (split !== 'dev' && split !== 'heldout') throw new Error('');
      if (metadata.has(raw.recordIndex)) throw new Error('');
      metadata.set(raw.recordIndex, { key: `synthetic:${format}:${raw.recordIndex}`, label: label.real,
        group: label.group, trap: label.trap, split, emulation: emulationFacts(raw) });
    }
    const output = await runPipeline({ text, format, files: generated.files, projectSalt });
    const matchLine = await runPipeline({ text, format, projectSalt });
    const matchLineByRecord = new Map(matchLine.sourceRecordIndices.map((record, index) => [record, matchLine.findings[index]]));
    if (output.findings.length !== parsed.candidates.length || output.sourceRecordIndices.length !== output.findings.length) throw new Error('');
    for (let i = 0; i < output.findings.length; i++) {
      const meta = metadata.get(output.sourceRecordIndices[i]);
      if (!meta) throw new Error('');
      const matchLineFinding = matchLineByRecord.get(output.sourceRecordIndices[i]);
      if (!matchLineFinding) throw new Error('');
      samples.push({ ...meta, finding: output.findings[i], matchLineFinding });
    }
    parsed.candidates.length = 0; parsed.extraValues.length = 0;
  }
  values.length = 0; kept.length = 0; valueGroups.clear();
  // Only masked findings, boolean facts, labels and metadata survive this function. Raw generated references die here.
  return { samples, guard, manifest: generated.manifest };
}
