import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalIdentitySalt } from './identity.ts';
import { loadSynthetic } from './data.ts';
import { claim, limitationsMarkdown, resultsMarkdown } from './report.ts';
import type { ReportBundle } from './report.ts';
import { createEvalJudges } from './live.ts';
import { runEvaluation } from '../src/core/evalkit/run.ts';
import { computeMetrics } from '../src/core/evalkit/metrics.ts';
import { tuneDev } from '../src/core/evalkit/tune.ts';
import { JudgeCache } from '../src/core/evalkit/cache.ts';
import { createMockJudge } from '../src/core/providers/mock.ts';
import { loadThresholds } from '../src/core/policy/thresholds.ts';
import { pipelineConfig } from '../src/core/pipeline.ts';
import { serializeSafe } from '../src/core/safe.ts';
import { promptFingerprint, sha256Hex, stableStringify } from '../src/core/judge/fingerprint.ts';
import { JUDGE_SCHEMA_VERSION, MASKED_VIEW_SCHEMA_VERSION } from '../src/core/judge/schema.ts';
import { bindThresholdLineage, operatingIdentity, studyIdentity, validateFrozenStudy, validateThresholdLineage } from './study.ts';
import type { FrozenStudy, PromotionConfig, ThresholdLineage } from './study.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
/** Preserve every prior artifact before replacing it. This script never deletes files. */
async function preserveWrite(relative: string, content: string): Promise<void> {
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) throw new Error('');
  await mkdir(dirname(path), { recursive: true });
  if (await exists(path)) {
    let suffix = 1;
    while (await exists(`${path}.bak-${suffix}`)) suffix++;
    await copyFile(path, `${path}.bak-${suffix}`);
  }
  await writeFile(path, content, 'utf8');
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes('--live'); const tune = args.includes('--tune');
  const exploratory = args.includes('--exploratory');
  const intArg = (name: string, fallback: number) => {
    const index = args.indexOf(name); const value = index < 0 ? fallback : Number(args[index + 1]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(''); return value;
  };
  if (tune && !live) throw new Error('');
  const seed = intArg('--seed', 26024); const size = intArg('--size', 400);
  const loaded = await loadSynthetic(seed, size, await evalIdentitySalt(root));
  const guard = loaded.guard;
  const manifestPath = resolve(root, 'fixtures/synthetic-manifest.json');
  const previous: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const promotion = JSON.parse(await readFile(resolve(root, 'config/promotion.json'), 'utf8')) as PromotionConfig;
  if (promotion.target_recall !== 0.98 || promotion.equivalence_enabled !== false || promotion.margin !== null) throw new Error('');
  const configFiles = await Promise.all(['prefixes', 'signals', 'high-precision-rules'].map(async name =>
    JSON.parse(await readFile(resolve(root, 'config/' + name + '.json'), 'utf8')) as unknown));
  const configuration = { evaluatorVersion: 'eval-v1', prefixes: configFiles[0], signals: configFiles[1], highPrecisionRules: configFiles[2],
    promptFingerprint: await promptFingerprint(), judgeSchema: JUDGE_SCHEMA_VERSION, viewSchema: MASKED_VIEW_SCHEMA_VERSION };
  const expectedStudy = await studyIdentity(loaded.manifest, loaded.samples, promotion, configuration);
  let frozen: FrozenStudy | undefined;
  if ((previous as { frozenAt?: unknown } | null)?.frozenAt) frozen = await validateFrozenStudy(previous, loaded.manifest, expectedStudy);
  if (args.includes('--freeze') && !frozen) {
    frozen = { ...loaded.manifest, frozenAt: new Date().toISOString(), promotion,
      studyIdentity: expectedStudy.identity, studyHash: expectedStudy.hash };
    await preserveWrite('fixtures/synthetic-manifest.json', serializeSafe(frozen, 'export', guard) + '\n');
  }
  const frozenAt = frozen?.frozenAt ?? null;
  if (live && (!frozen || (frozen.heldoutRunAt && !exploratory))) throw new Error('');
  let thresholdArtifact: unknown = JSON.parse(await readFile(resolve(root, 'config/thresholds.json'), 'utf8'));
  let thresholds = loadThresholds(thresholdArtifact);
  const caps = JSON.parse(await readFile(resolve(root, 'config/caps.json'), 'utf8')) as { eval_usd: number };
  const maxUsd = Number(process.env.JUDGE_EVAL_USD ?? caps.eval_usd);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('');
  const judges = live ? await createEvalJudges(guard, maxUsd) : { generative: createMockJudge(seed), jev: createMockJudge(seed) };
  const operatingHash = await operatingIdentity(configuration, {
    generative: judges.generative?.descriptor ?? null, jev: judges.jev?.descriptor ?? null });
  const configVersionFor = (value: typeof thresholds) => sha256Hex(stableStringify({ operatingHash, thresholds: value }));
  const highPrecisionRules = pipelineConfig().signals.highPrecisionRules;
  const cache = new JudgeCache();
  const cacheDocument = JSON.parse(await readFile(resolve(root, 'fixtures/judge-cache.json'), 'utf8')) as { entries?: unknown };
  if (!Array.isArray(cacheDocument.entries) || cacheDocument.entries.length > 50_000) throw new Error('');
  await cache.importEntries(cacheDocument.entries, guard);
  const dev = loaded.samples.filter(sample => sample.split === 'dev');
  const heldout = loaded.samples.filter(sample => sample.split === 'heldout');
  if (tune) {
    if (!frozen || !judges.generative || judges.generative.descriptor.kind === 'scripted-mock') throw new Error('');
    const devResult = await runEvaluation({ samples: dev, guard, thresholds, highPrecisionRules, judges, cache,
      configVersion: await configVersionFor(thresholds), targetRecall: promotion.target_recall });
    const row = devResult.methods.find(method => method.method === 'generative');
    if (!row || row.status !== 'computed' || row.observations.length !== dev.length) throw new Error('');
    const tuned = tuneDev({ samples: dev, observations: row.observations, method: 'generative', baseThresholds: thresholds, highPrecisionRules, targetRecall: promotion.target_recall });
    thresholds = tuned.thresholds;
    thresholdArtifact = await bindThresholdLineage(thresholds, frozen.studyHash, dev, operatingHash, judges.generative.descriptor);
    // Durable lineage precedes every held-out marker/call, including the infeasible/no-dismiss dev disposition.
    await preserveWrite('config/thresholds.json', serializeSafe(thresholdArtifact, 'export', guard) + '\n');
  }
  const hasLiveJudge = Object.values(judges).some(judge => judge && judge.descriptor.kind !== 'scripted-mock');
  let tuning: ThresholdLineage | null = null;
  if (live && hasLiveJudge) {
    if (!frozen) throw new Error('');
    tuning = (await validateThresholdLineage(thresholdArtifact, frozen.studyHash, dev, operatingHash)).lineage;
  }
  const started = new Date().toISOString();
  if (live && hasLiveJudge && frozen) {
    frozen = { ...frozen, heldoutRunAt: started, heldoutStatus: exploratory ? 'exploratory-started' : 'started' };
    await preserveWrite('fixtures/synthetic-manifest.json', serializeSafe(frozen, 'export', guard) + '\n');
  }
  const configVersion = await configVersionFor(thresholds);
  const scoring = await runEvaluation({ samples: heldout, guard, thresholds, highPrecisionRules, judges, cache,
    configVersion, targetRecall: promotion.target_recall });
  if (exploratory) scoring.promotion = { eligible: false, promoted: false, equivalenceEnabled: false, reasons: [...scoring.promotion.reasons, 'Exploratory repeat cannot earn preregistered promotion.'] };
  const bundle: ReportBundle = {
    dataset: { name: `author-written synthetic set${exploratory ? ' (exploratory repeat)' : ''}`, seed, generatorVersion: loaded.manifest.generatorVersion, frozenAt,
      dev: { n: dev.length, real: dev.filter(sample => sample.label).length }, heldout: { n: heldout.length, real: heldout.filter(sample => sample.label).length } },
    mode: live ? 'live' : 'scripted-mock', generatedAt: started, scoring,
    operating: { studyHash: frozen?.studyHash ?? null, operatingHash, configVersion, thresholds,
      thresholdHash: await sha256Hex(stableStringify(thresholds)), tuning,
      disposition: live && hasLiveJudge ? exploratory ? 'exploratory-live' : 'primary-live' : live ? 'not-run' : 'interface-replay' },
  };
  bundle.breakdowns = [];
  for (const kind of ['trap', 'rule'] as const) {
    const nameOf = (sample: typeof heldout[number]) => kind === 'trap' ? sample.trap ?? 'background' : sample.finding.ruleId;
    for (const name of new Set(heldout.map(nameOf))) {
      const stratum = heldout.filter(sample => nameOf(sample) === name);
      const keys = new Set(stratum.map(sample => sample.key));
      for (const row of scoring.methods.filter(method => method.metrics !== null)) {
        bundle.breakdowns.push({ kind, name, method: row.method, metrics: computeMetrics(stratum, row.observations.filter(observation => keys.has(observation.sampleKey))) });
      }
    }
  }
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  const block = `<!-- CLAIM:BEGIN -->\n${claim(bundle)}\n<!-- CLAIM:END -->`;
  const nextReadme = /<!-- CLAIM:BEGIN -->[\s\S]*?<!-- CLAIM:END -->/.test(readme) ? readme.replace(/<!-- CLAIM:BEGIN -->[\s\S]*?<!-- CLAIM:END -->/, () => block) : `${readme}\n${block}\n`;
  const artifacts = [
    ['results/results.md', resultsMarkdown(bundle)],
    ['results/results.jsonl', serializeSafe(bundle, 'export', guard) + '\n'],
    ['docs/LIMITATIONS.md', limitationsMarkdown(bundle, heldout)],
    ['README.md', nextReadme],
    ['fixtures/judge-cache.json', serializeSafe({ schemaVersion: 1, entries: cache.entries() }, 'cache', guard) + '\n'],
  ];
  // Guard every complete artifact before writing any; a collision stops the operation without leaking diagnostic text.
  for (const [, value] of artifacts) serializeSafe(value, 'export', guard);
  for (const [path, value] of artifacts) await preserveWrite(path, value);
  if (live && hasLiveJudge && frozen) await preserveWrite('fixtures/synthetic-manifest.json', serializeSafe({ ...frozen, heldoutStatus: exploratory ? 'exploratory-completed' : 'completed' }, 'export', guard) + '\n');
}
// Never print caught engine/provider/report diagnostics, even on failure.
void main().catch(() => { process.exitCode = 1; });
