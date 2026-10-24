// Seeded synthetic data generator (Claude §5.4, PLAN M1 item 8).
// Produces small synthetic repos (file path -> content), a gitleaks JSON array report and a trufflehog NDJSON report over
// them, a label per report record, and a manifest (no raw values). Deterministic for a given (seed, size, variant).
// Synthetic data only: tokens are random and never valid; no claim of natural prevalence.
import { createRng } from '../rng.ts';
import type { Rng } from '../rng.ts';
import { commitSha } from './tokens.ts';
import {
  ALL_TRAPS,
  TRAP_BUILDERS,
  TRAP_COUNTS,
  buildFingerprintCollision,
  buildShortValue,
  buildT19,
  buildUnreportedContext,
  pickBackground,
  plantRecordCount,
} from './traps.ts';
import type { PathKind, Plant, PlantFinding, Style, TrapId } from './traps.ts';
import { emitGitleaks, emitTrufflehog, labelKey } from './emit.ts';
import { applyRun2 } from './variants.ts';

export const GENERATOR_VERSION = 'synth-v1';
export const DEFAULT_SIZE = 400;

export type Split = 'dev' | 'heldout';
export type Variant = 'run1' | 'run2';

export interface SynthOptions {
  seed: number;
  /** Target number of report records (gitleaks + trufflehog), ~400. The trap set is always included, so tiny sizes overshoot. */
  size?: number;
  variant?: Variant;
}

export interface SynthLabel {
  real: boolean;
  trap?: TrapId;
  /** File group id (= synthetic repo id); the unit of the dev/held-out split. */
  group: string;
}

export interface SplitCounts {
  groups: number;
  records: number;
  real: number;
  negative: number;
}

export interface SynthManifest {
  generatorVersion: string;
  seed: number;
  requestedSize: number;
  variant: Variant;
  /** Set by the evaluation script when the split is frozen; the generator never sets it. */
  frozenAt: string | null;
  counts: {
    records: number;
    gitleaks: number;
    trufflehog: number;
    real: number;
    negative: number;
    bySplit: Record<Split, SplitCounts>;
    byTrap: Record<string, number>;
  };
  /** Group id -> split. All occurrences of one underlying value share a group (T15), hence a split. */
  splits: Record<string, Split>;
  groups: Array<{ id: string; split: Split; gitMode: boolean; files: number; records: number }>;
  /** Label keys of the two run-2 changes (present for both variants so run 1 and run 2 can be joined). */
  run2: { contextChangedKey: string; replacedKey: string };
  notes: string[];
}

/**
 * RAW test oracle. Contains raw synthetic values so the no-leak suite can search outbound artefacts for them.
 * Never serialise, persist, post from the worker, or send anywhere.
 */
export interface SynthRawOracle {
  /** Every reported raw value (deduplicated). */
  reportedValues: string[];
  /** Credential-looking values present in files but reported by no scanner. */
  unreportedValues: string[];
  /** Values that also appear inside git-mode scanner fingerprints (commit hash collision fixture). */
  fingerprintValues: string[];
  /** Values shorter than 6 characters (whole-value checks). */
  shortValues: string[];
  /** Label keys of findings whose value is repeated in other files (T15) and of adjacent pairs. */
  repeatedValueKeys: string[];
  adjacentPairKeys: string[];
}

export interface SynthResult {
  gitleaksJson: string;
  trufflehogNdjson: string;
  files: Record<string, string>;
  labels: Record<string, SynthLabel>;
  manifest: SynthManifest;
  rawOracle: SynthRawOracle;
}

// ---- internal model (shared with emit.ts / variants.ts via type-only imports) ----

export type LineKind = 'filler' | 'plant';

export interface SynthFile {
  path: string;
  group: string;
  style: Style;
  lines: string[];
  lineKinds: LineKind[];
}

export interface SynthGroup {
  id: string;
  index: number;
  gitMode: boolean;
  commit?: string;
  split: Split;
}

export interface PlacedFinding {
  path: string;
  group: string;
  /** 1-based start line. */
  line: number;
  /** 1-based end line (multi-line PEM values span several). */
  endLine: number;
  value: string;
  gitleaksRule?: string;
  trufflehog?: { detector: string; verified: boolean } | undefined;
  real: boolean;
  trap?: TrapId;
  matchMode: 'value' | 'assignment';
  role?: 'run2-replace' | 'run2-context';
  commit?: string;
  tag?: Plant['tag'];
}

export interface SynthModel {
  seed: number;
  size: number;
  groups: SynthGroup[];
  files: SynthFile[];
  findings: PlacedFinding[];
  unreported: string[];
  fingerprintValues: string[];
}

// ---- file layout ----

const FILE_CANDIDATES: Partial<Record<PathKind, Partial<Record<Style, readonly string[]>>>> = {
  source: { py: ['src/settings.py', 'src/app/client.py', 'src/services/payments.py'], js: ['src/config.js', 'src/lib/api.js', 'web/src/env.js'] },
  config: { yaml: ['config/settings.yaml', 'deploy/values.yaml'], env: ['config/production.env', 'deploy/app.env'] },
  test: { py: ['tests/test_auth.py', 'tests/test_client.py'], js: ['src/__tests__/api.test.js', 'test/client.spec.js'] },
  fixture: { json: ['tests/fixtures/credentials.json', 'fixtures/sample-config.json'], yaml: ['tests/fixtures/config.yaml'] },
  docs: { md: ['docs/setup.md', 'README.md', 'docs/deploy.md'] },
  lockfile: { json: ['package-lock.json'] },
  ci: { yaml: ['ci/deploy.yml', 'ci/release.yml'] },
  script: { sh: ['scripts/deploy.sh', 'scripts/bootstrap.sh'] },
};

const KIND_DIR: Record<PathKind, string> = {
  source: 'src', config: 'config', test: 'tests', fixture: 'tests/fixtures', docs: 'docs', lockfile: '', ci: 'ci', script: 'scripts',
};

const STYLE_EXT: Record<Style, string> = { py: 'py', js: 'js', yaml: 'yaml', env: 'env', md: 'md', json: 'json', sh: 'sh' };

function chooseFile(p: Plant, rng: Rng): string {
  if (p.file !== undefined) return p.file;
  const list = FILE_CANDIDATES[p.kind]?.[p.style];
  if (list !== undefined && list.length > 0) return rng.pick(list);
  const dir = KIND_DIR[p.kind];
  return `${dir === '' ? '' : dir + '/'}settings.${STYLE_EXT[p.style]}`;
}

export const FILLER: Record<Style, readonly string[]> = {
  py: ['import os', 'import logging', 'logger = logging.getLogger(__name__)', '', 'def load_settings():', '    return {}',
    'TIMEOUT_SECONDS = 30', 'RETRIES = 3', '# TODO: move to the settings module', 'DEBUG = False', 'class Client:', '    pass'],
  js: ["'use strict';", "import { readFile } from 'node:fs/promises';", 'const TIMEOUT_MS = 30000;', 'export function init() {',
    '  return null;', '}', '// TODO: tidy up config loading', 'let retries = 3;', ''],
  yaml: ['service:', '  name: billing', '  replicas: 2', 'logging:', '  level: info', '# defaults for local development',
    'timeout: 30', 'region: us-east-1'],
  env: ['LOG_LEVEL=info', 'PORT=8080', 'NODE_ENV=production', '# local overrides', 'FEATURE_FLAGS=search,billing', 'REGION=us-east-1'],
  md: ['# Setup', '', 'This guide explains how to run the service locally.', '## Configuration', 'Copy the sample config and edit it.',
    '- Install dependencies', '- Start the dev server'],
  json: ['{', '  "name": "synthetic-app",', '  "version": "1.0.0",', '  "private": true,', '  "lockfileVersion": 3,',
    '      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",', '}'],
  sh: ['#!/usr/bin/env bash', 'set -euo pipefail', 'echo "deploying"', 'cd "$(dirname "$0")"', '# deploy helper', 'make build'],
};

function isKeyFile(path: string): boolean {
  return path.endsWith('.pem') || path.endsWith('.key');
}

// ---- union-find over values (T15: all occurrences of one value share a group) ----

function componentsByValue(plants: Plant[]): number[][] {
  const parent = plants.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    let c = i;
    while (parent[c] !== r) {
      const n = parent[c] as number;
      parent[c] = r;
      c = n;
    }
    return r;
  };
  const owner = new Map<string, number>();
  plants.forEach((p, i) => {
    const vals = [...p.findings.map((f) => f.value), ...(p.unreported ?? [])];
    for (const v of vals) {
      const o = owner.get(v);
      if (o === undefined) owner.set(v, i);
      else parent[find(i)] = find(o);
    }
  });
  const comps = new Map<number, number[]>();
  plants.forEach((_, i) => {
    const r = find(i);
    const list = comps.get(r);
    if (list === undefined) comps.set(r, [i]);
    else list.push(i);
  });
  return [...comps.values()];
}

// ---- main ----

function scaled(count: number, size: number): number {
  return size >= DEFAULT_SIZE ? count : Math.max(1, Math.round((count * size) / DEFAULT_SIZE));
}

/** Build the run-1 model. Exported for tests and for the variant module. */
export function buildModel(seed: number, size: number): SynthModel {
  const root = createRng(seed);
  const rngPlants = root.fork('plants');
  const rngLayout = root.fork('layout');
  const plants: Plant[] = [];

  for (const t of Object.keys(TRAP_COUNTS) as (keyof typeof TRAP_COUNTS)[]) {
    const n = scaled(TRAP_COUNTS[t], size);
    for (let i = 0; i < n; i++) plants.push(...TRAP_BUILDERS[t](rngPlants));
  }
  plants.push(...buildT19(rngPlants));
  for (let i = 0; i < scaled(3, size); i++) plants.push(...buildUnreportedContext(rngPlants));
  for (let i = 0; i < scaled(2, size); i++) plants.push(...buildShortValue(rngPlants));

  let records = plants.reduce((s, p) => s + plantRecordCount(p), 0);
  while (records < size) {
    const more = pickBackground(rngPlants)(rngPlants);
    plants.push(...more);
    records += more.reduce((s, p) => s + plantRecordCount(p), 0);
  }

  // Groups (synthetic repos). Every 4th group starting at index 1 is "git mode" (fingerprint carries the commit).
  const nGroups = Math.min(64, Math.max(4, Math.round(plants.length / 12)));
  const groups: SynthGroup[] = [];
  for (let i = 0; i < nGroups; i++) {
    const gitMode = i % 4 === 1;
    const g: SynthGroup = { id: `repo-${String(i + 1).padStart(2, '0')}`, index: i, gitMode, split: 'dev' };
    if (gitMode) g.commit = commitSha(rngLayout);
    groups.push(g);
  }
  // Commit-hash collision fixture: a finding whose value is the commit carried by that group's git-mode fingerprints.
  const firstGit = groups.find((g) => g.gitMode);
  const fingerprintValues: string[] = [];
  if (firstGit !== undefined && firstGit.commit !== undefined) {
    plants.push(...buildFingerprintCollision(firstGit.commit, firstGit.index));
    fingerprintValues.push(firstGit.commit);
  }

  // Split by group (frozen here; the eval records the freeze date).
  const order = rngLayout.shuffle(groups.map((g) => g.index));
  const nDev = Math.ceil(nGroups / 2);
  order.forEach((gi, k) => {
    (groups[gi] as SynthGroup).split = k < nDev ? 'dev' : 'heldout';
  });

  // Assign value-components to groups: forced first, then greedy least-loaded (deterministic after shuffle).
  const comps = rngLayout.shuffle(componentsByValue(plants));
  const load = new Array<number>(nGroups).fill(0);
  const plantGroup = new Array<number>(plants.length).fill(-1);
  const forced = comps.filter((c) => c.some((i) => (plants[i] as Plant).forceGroup !== undefined));
  const free = comps.filter((c) => !forced.includes(c));
  for (const c of [...forced, ...free]) {
    const f = c.map((i) => (plants[i] as Plant).forceGroup).find((x) => x !== undefined);
    let gi = f ?? 0;
    if (f === undefined) {
      for (let k = 1; k < nGroups; k++) if ((load[k] as number) < (load[gi] as number)) gi = k;
    }
    for (const i of c) plantGroup[i] = gi;
    load[gi] = (load[gi] as number) + c.length;
  }

  // Assign plants to files inside each group, preserving the shuffled order.
  const fileMap = new Map<string, { group: SynthGroup; style: Style; plants: Plant[] }>();
  const plantOrder = rngLayout.shuffle(plants.map((_, i) => i));
  for (const i of plantOrder) {
    const p = plants[i] as Plant;
    const g = groups[plantGroup[i] as number] as SynthGroup;
    const path = `${g.id}/${chooseFile(p, rngLayout)}`;
    const entry = fileMap.get(path);
    if (entry === undefined) fileMap.set(path, { group: g, style: p.style, plants: [p] });
    else entry.plants.push(p);
  }

  // Render files.
  const files: SynthFile[] = [];
  const findings: PlacedFinding[] = [];
  const unreported: string[] = [];
  const paths = [...fileMap.keys()].sort();
  for (const path of paths) {
    const entry = fileMap.get(path) as { group: SynthGroup; style: Style; plants: Plant[] };
    const keyFile = isKeyFile(path);
    const filler = FILLER[entry.style];
    const file: SynthFile = { path, group: entry.group.id, style: entry.style, lines: [], lineKinds: [] };
    const pushFiller = (n: number) => {
      for (let k = 0; k < n; k++) {
        file.lines.push(keyFile ? '' : rngLayout.pick(filler));
        file.lineKinds.push('filler');
      }
    };
    if (!keyFile) pushFiller(rngLayout.int(1, 4));
    entry.plants.forEach((p, idx) => {
      if (idx > 0) pushFiller(keyFile ? 1 : rngLayout.int(1, 4));
      const start = file.lines.length; // 0-based index of block line 0
      for (const l of p.block) {
        file.lines.push(l);
        file.lineKinds.push('plant');
      }
      for (const f of p.findings) findings.push(place(f, p, path, entry.group, start));
      if (p.unreported !== undefined) unreported.push(...p.unreported);
    });
    if (!keyFile) pushFiller(rngLayout.int(1, 3));
    files.push(file);
  }

  // Mark the run-2 context target: the first single-line T05 gitleaks finding with a filler line directly above.
  const byPath = new Map(files.map((f) => [f.path, f]));
  const ctx = findings.find((f) => f.trap === 'T05' && f.gitleaksRule !== undefined && f.line >= 2
    && byPath.get(f.path)?.lineKinds[f.line - 2] === 'filler')
    ?? findings.find((f) => f.gitleaksRule !== undefined && f.line === f.endLine && f.line >= 2 && f.role === undefined
      && byPath.get(f.path)?.lineKinds[f.line - 2] === 'filler');
  if (ctx === undefined) throw new Error('synth: no run-2 context target found');
  ctx.role = 'run2-context';

  return { seed, size, groups, files, findings, unreported, fingerprintValues };
}

function place(f: PlantFinding, p: Plant, path: string, g: SynthGroup, blockStart: number): PlacedFinding {
  const lines = f.value.split('\n').length;
  const line = blockStart + f.lineOffset + 1;
  const pf: PlacedFinding = {
    path, group: g.id, line, endLine: line + lines - 1, value: f.value, real: f.real,
    matchMode: f.matchMode ?? 'value', trufflehog: f.trufflehog,
  };
  if (f.gitleaksRule !== undefined) pf.gitleaksRule = f.gitleaksRule;
  if (f.trap !== undefined) pf.trap = f.trap;
  if (f.role !== undefined) pf.role = f.role;
  if (g.commit !== undefined) pf.commit = g.commit;
  if (p.tag !== undefined) pf.tag = p.tag;
  return pf;
}

export function generateSynthetic(opts: SynthOptions): SynthResult {
  const size = opts.size ?? DEFAULT_SIZE;
  const variant: Variant = opts.variant ?? 'run1';
  if (!Number.isInteger(size) || size < 1 || size > 20_000) throw new Error('generateSynthetic: size must be an integer in 1..20000');
  const model = buildModel(opts.seed, size);
  const run2Keys = applyRun2(model, createRng(opts.seed).fork('run2'), variant === 'run2');

  const gitleaks = emitGitleaks(model);
  const trufflehog = emitTrufflehog(model);
  const files: Record<string, string> = {};
  for (const f of model.files) files[f.path] = f.lines.join('\n') + '\n';

  // Labels: one per report record. Keys must be unique.
  const labels: Record<string, SynthLabel> = {};
  const addLabel = (key: string, f: PlacedFinding) => {
    if (key in labels) throw new Error(`synth: duplicate label key ${key}`);
    const l: SynthLabel = { real: f.real, group: f.group };
    if (f.trap !== undefined) l.trap = f.trap;
    labels[key] = l;
  };
  for (const f of model.findings) {
    if (f.gitleaksRule !== undefined) addLabel(labelKey('gitleaks', f.path, f.line, f.gitleaksRule), f);
    if (f.trufflehog !== undefined) addLabel(labelKey('trufflehog', f.path, f.line, f.trufflehog.detector), f);
  }

  const manifest = buildManifest(model, labels, size, variant, run2Keys);
  const valueCount = new Map<string, number>();
  for (const f of model.findings) valueCount.set(f.value, (valueCount.get(f.value) ?? 0) + 1);
  const keysOf = (pred: (f: PlacedFinding) => boolean): string[] => model.findings.filter(pred)
    .flatMap((f) => [
      ...(f.gitleaksRule !== undefined ? [labelKey('gitleaks', f.path, f.line, f.gitleaksRule)] : []),
      ...(f.trufflehog !== undefined ? [labelKey('trufflehog', f.path, f.line, f.trufflehog.detector)] : []),
    ]);

  return {
    gitleaksJson: gitleaks,
    trufflehogNdjson: trufflehog,
    files,
    labels,
    manifest,
    rawOracle: {
      reportedValues: [...new Set(model.findings.map((f) => f.value))],
      unreportedValues: [...new Set(model.unreported)],
      fingerprintValues: model.fingerprintValues.slice(),
      shortValues: [...new Set(model.findings.map((f) => f.value).filter((v) => v.length < 6))],
      repeatedValueKeys: keysOf((f) => (valueCount.get(f.value) ?? 0) > 1),
      adjacentPairKeys: keysOf((f) => f.tag === 'adjacent-pair'),
    },
  };
}

function buildManifest(
  model: SynthModel,
  labels: Record<string, SynthLabel>,
  size: number,
  variant: Variant,
  run2: { contextChangedKey: string; replacedKey: string },
): SynthManifest {
  const splits: Record<string, Split> = {};
  for (const g of model.groups) splits[g.id] = g.split;
  const empty = (): SplitCounts => ({ groups: 0, records: 0, real: 0, negative: 0 });
  const bySplit: Record<Split, SplitCounts> = { dev: empty(), heldout: empty() };
  const byTrap: Record<string, number> = {};
  for (const t of ALL_TRAPS) byTrap[t] = 0;
  const perGroup = new Map<string, number>();
  let gl = 0;
  let th = 0;
  let real = 0;
  for (const [key, l] of Object.entries(labels)) {
    if (key.startsWith('gitleaks|')) gl++;
    else th++;
    if (l.real) real++;
    const s = bySplit[splits[l.group] as Split];
    s.records++;
    if (l.real) s.real++;
    else s.negative++;
    if (l.trap !== undefined) byTrap[l.trap] = (byTrap[l.trap] ?? 0) + 1;
    perGroup.set(l.group, (perGroup.get(l.group) ?? 0) + 1);
  }
  for (const g of model.groups) bySplit[g.split].groups++;
  const filesPerGroup = new Map<string, number>();
  for (const f of model.files) filesPerGroup.set(f.group, (filesPerGroup.get(f.group) ?? 0) + 1);
  const total = gl + th;
  return {
    generatorVersion: GENERATOR_VERSION,
    seed: model.seed,
    requestedSize: size,
    variant,
    frozenAt: null,
    counts: { records: total, gitleaks: gl, trufflehog: th, real, negative: total - real, bySplit, byTrap },
    splits,
    groups: model.groups.map((g) => ({
      id: g.id, split: g.split, gitMode: g.gitMode, files: filesPerGroup.get(g.id) ?? 0, records: perGroup.get(g.id) ?? 0,
    })),
    run2,
    notes: [
      'Synthetic data only. Real-format tokens are random, never valid, and assembled at run time from split parts.',
      'Trap frequencies are author-chosen; no claim of natural prevalence.',
      'Split is by file group (synthetic repo); every occurrence of one underlying value is in one group.',
      'T13, T14 and T18 are trufflehog-only records (verification traps are evaluated per report; cross-report merging is out of scope).',
      'Synthetic gitleaks records omit the `Line` field (believed not emitted by gitleaks JSON; unverified, D1).',
    ],
  };
}
