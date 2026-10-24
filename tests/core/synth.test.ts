// Synthetic generator tests (package C). Written in Dirty Mode construction, NOT run (D3, D20).
// what_bug_this_catches: non-deterministic fixtures, a missing trap, report/label drift, values crossing the dev/held-out
// split (T15), a broken run-2 variant (T19 / changed context), and token-shaped literals committed to source (D14).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRng, hashString32 } from '../../src/core/rng.ts';
import {
  ALL_TRAPS,
  TOKEN_SPECS,
  awsDocsExampleKeyId,
  awsDocsExampleSecret,
  generateSynthetic,
  knownPrefixes,
  labelKey,
} from '../../src/core/synth/index.ts';
import type { GitleaksRecord, SynthResult, TrufflehogRecord } from '../../src/core/synth/index.ts';

const SEED = 20261024;

function gitleaks(r: SynthResult): GitleaksRecord[] {
  return JSON.parse(r.gitleaksJson) as GitleaksRecord[];
}

function trufflehog(r: SynthResult): TrufflehogRecord[] {
  return r.trufflehogNdjson.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as TrufflehogRecord);
}

/** [label key, raw value] for every report record. */
function records(r: SynthResult): Array<[string, string]> {
  return [
    ...gitleaks(r).map((g): [string, string] => [labelKey('gitleaks', g.File, g.StartLine, g.RuleID), g.Secret]),
    ...trufflehog(r).map((t): [string, string] => [
      labelKey('trufflehog', t.SourceMetadata.Data.Filesystem.file, t.SourceMetadata.Data.Filesystem.line, t.DetectorName),
      t.Raw,
    ]),
  ];
}

function charClassAt(c: string): string {
  if (/[A-Z]/.test(c)) return 'U';
  if (/[a-z]/.test(c)) return 'L';
  if (/[0-9]/.test(c)) return 'D';
  return c;
}

const run1 = generateSynthetic({ seed: SEED });
const run2 = generateSynthetic({ seed: SEED, variant: 'run2' });

describe('rng', () => {
  it('is deterministic per seed and forks independently', () => {
    const a = createRng(5);
    const b = createRng(5);
    const seqA = [a.next(), a.next(), a.int(0, 100), a.chars('abc', 8)];
    const seqB = [b.next(), b.next(), b.int(0, 100), b.chars('abc', 8)];
    expect(seqA).toEqual(seqB);
    expect(createRng(6).next()).not.toBe(createRng(5).next());
    const f1 = createRng(5).fork('x').next();
    const f2 = createRng(5).fork('x').next();
    expect(f1).toBe(f2);
    expect(createRng(5).fork('y').next()).not.toBe(f1);
    expect(hashString32('abc')).toBe(hashString32('abc'));
  });

  it('shuffle and sample do not mutate their input', () => {
    const r = createRng(9);
    const input = [1, 2, 3, 4, 5, 6];
    const out = r.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...out].sort()).toEqual(input);
    expect(new Set(r.sample(input, 4)).size).toBe(4);
    expect(() => r.int(3, 3)).toThrow();
  });
});

describe('generateSynthetic determinism and size', () => {
  it('produces byte-identical output for the same seed', () => {
    const again = generateSynthetic({ seed: SEED });
    expect(again.gitleaksJson).toBe(run1.gitleaksJson);
    expect(again.trufflehogNdjson).toBe(run1.trufflehogNdjson);
    expect(again.files).toEqual(run1.files);
    expect(again.labels).toEqual(run1.labels);
    expect(again.manifest).toEqual(run1.manifest);
  });

  it('differs for a different seed', () => {
    const other = generateSynthetic({ seed: SEED + 1 });
    expect(other.gitleaksJson).not.toBe(run1.gitleaksJson);
  });

  it('targets about 400 records by default', () => {
    const n = run1.manifest.counts.records;
    expect(n).toBeGreaterThanOrEqual(400);
    expect(n).toBeLessThanOrEqual(410);
    expect(n).toBe(run1.manifest.counts.gitleaks + run1.manifest.counts.trufflehog);
    expect(run1.manifest.counts.real).toBeGreaterThan(0);
    expect(run1.manifest.counts.negative).toBeGreaterThan(0);
  });

  it('keeps every trap even at a tiny size', () => {
    const tiny = generateSynthetic({ seed: 3, size: 20 });
    for (const t of ALL_TRAPS) expect(tiny.manifest.counts.byTrap[t]).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid sizes', () => {
    expect(() => generateSynthetic({ seed: 1, size: 0 })).toThrow();
    expect(() => generateSynthetic({ seed: 1, size: 20_001 })).toThrow();
  });
});

describe('traps T01-T19', () => {
  it('every trap is present in labels and manifest', () => {
    const seen = new Set(Object.values(run1.labels).map((l) => l.trap).filter((t) => t !== undefined));
    for (const t of ALL_TRAPS) {
      expect(seen.has(t)).toBe(true);
      expect(run1.manifest.counts.byTrap[t]).toBeGreaterThanOrEqual(1);
    }
  });

  it('T13 and T18 are trufflehog Verified:true, T14 is Verified:false, and none of them is in gitleaks', () => {
    const th = trufflehog(run1);
    const byTrap = (t: string) => th.filter((r) => run1.labels[labelKey('trufflehog', r.SourceMetadata.Data.Filesystem.file,
      r.SourceMetadata.Data.Filesystem.line, r.DetectorName)]?.trap === t);
    for (const t of ['T13', 'T18']) {
      expect(byTrap(t).length).toBeGreaterThanOrEqual(1);
      expect(byTrap(t).every((r) => r.Verified === true)).toBe(true);
    }
    expect(byTrap('T14').length).toBeGreaterThanOrEqual(1);
    expect(byTrap('T14').every((r) => r.Verified === false)).toBe(true);
    const glTraps = new Set(gitleaks(run1).map((g) => run1.labels[labelKey('gitleaks', g.File, g.StartLine, g.RuleID)]?.trap));
    for (const t of ['T13', 'T14', 'T18']) expect(glTraps.has(t as never)).toBe(false);
  });

  it('T01 uses the documented AWS example pair (assembled at run time)', () => {
    const t01 = gitleaks(run1).filter((g) => run1.labels[labelKey('gitleaks', g.File, g.StartLine, g.RuleID)]?.trap === 'T01');
    const secrets = new Set(t01.map((g) => g.Secret));
    expect(secrets.has(awsDocsExampleKeyId())).toBe(true);
    expect(secrets.has(awsDocsExampleSecret())).toBe(true);
    expect(t01.every((g) => run1.labels[labelKey('gitleaks', g.File, g.StartLine, g.RuleID)]?.real === false)).toBe(true);
  });

  it('T17 puts a reference and a literal on the same line, with opposite labels', () => {
    const t17 = gitleaks(run1).filter((g) => run1.labels[labelKey('gitleaks', g.File, g.StartLine, g.RuleID)]?.trap === 'T17');
    const byLine = new Map<string, GitleaksRecord[]>();
    for (const g of t17) byLine.set(`${g.File}:${g.StartLine}`, [...(byLine.get(`${g.File}:${g.StartLine}`) ?? []), g]);
    const pairs = [...byLine.values()].filter((l) => l.length === 2);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    for (const [a, b] of pairs as [GitleaksRecord, GitleaksRecord][]) {
      const la = run1.labels[labelKey('gitleaks', a.File, a.StartLine, a.RuleID)];
      const lb = run1.labels[labelKey('gitleaks', b.File, b.StartLine, b.RuleID)];
      expect(la?.real).not.toBe(lb?.real);
    }
  });

  it('T15 repeats one value across at least three files', () => {
    const files = new Map<string, Set<string>>();
    for (const g of gitleaks(run1)) {
      if (run1.labels[labelKey('gitleaks', g.File, g.StartLine, g.RuleID)]?.trap !== 'T15') continue;
      files.set(g.Secret, (files.get(g.Secret) ?? new Set()).add(g.File));
    }
    expect([...files.values()].some((s) => s.size >= 3)).toBe(true);
  });

  it('T06 and T08 real-format tokens sit in test and docs paths and are labelled real', () => {
    for (const [trap, re] of [['T06', /(^|\/)(tests?|__tests__)\//], ['T08', /(^|\/)(docs\/|README\.md$)/]] as const) {
      const recs = gitleaks(run1).filter((g) => run1.labels[labelKey('gitleaks', g.File, g.StartLine, g.RuleID)]?.trap === trap);
      expect(recs.length).toBeGreaterThanOrEqual(1);
      for (const g of recs) {
        expect(re.test(g.File)).toBe(true);
        expect(run1.labels[labelKey('gitleaks', g.File, g.StartLine, g.RuleID)]?.real).toBe(true);
      }
    }
  });
});

describe('report shapes and label coverage', () => {
  it('every record has exactly one label and every label has a record', () => {
    const keys = records(run1).map(([k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(Object.keys(run1.labels).length);
    for (const k of keys) expect(run1.labels[k]).toBeDefined();
  });

  it('gitleaks records point at real file content and use the documented fingerprint forms', () => {
    const gitGroups = new Set(run1.manifest.groups.filter((g) => g.gitMode).map((g) => g.id));
    for (const g of gitleaks(run1)) {
      const content = run1.files[g.File];
      expect(content).toBeDefined();
      const lines = (content as string).split('\n');
      const first = g.Secret.split('\n')[0] as string;
      expect(lines[g.StartLine - 1]).toContain(first);
      expect(g.Match).toContain(first);
      // StartColumn is 1-based and points at the start of Match on the start line.
      expect(lines[g.StartLine - 1]?.slice(g.StartColumn - 1).startsWith(g.Match.split('\n')[0] as string)).toBe(true);
      expect(g.EndLine).toBe(g.StartLine + g.Secret.split('\n').length - 1);
      const group = g.File.split('/')[0] as string;
      if (gitGroups.has(group)) {
        expect(g.Commit).toMatch(/^[0-9a-f]{40}$/);
        expect(g.Fingerprint).toBe(`${g.Commit}:${g.File}:${g.RuleID}:${g.StartLine}`);
      } else {
        expect(g.Commit).toBe('');
        expect(g.Fingerprint).toBe(`${g.File}:${g.RuleID}:${g.StartLine}`);
      }
      expect(Number.isFinite(g.Entropy)).toBe(true);
    }
  });

  it('trufflehog records use the filesystem source with 1-based lines inside the file', () => {
    for (const t of trufflehog(run1)) {
      const fsrc = t.SourceMetadata.Data.Filesystem;
      const content = run1.files[fsrc.file];
      expect(content).toBeDefined();
      expect(fsrc.line).toBeGreaterThanOrEqual(1);
      expect((content as string).split('\n')[fsrc.line - 1]).toContain(t.Raw.split('\n')[0] as string);
      expect(typeof t.Verified).toBe('boolean');
    }
  });

  it('real-format tokens match the provider formats they claim', () => {
    for (const g of gitleaks(run1)) {
      if (g.RuleID === 'github-pat') expect(g.Secret.startsWith(TOKEN_SPECS.github_pat.prefix)).toBe(true);
      if (g.RuleID === 'aws-access-token') expect(g.Secret).toMatch(new RegExp(`^${TOKEN_SPECS.aws_access_key_id.prefix}[A-Z0-9]{16}$`));
    }
  });
});

describe('split integrity (grouped split, T15)', () => {
  it('no underlying value crosses groups or splits', () => {
    const groupsOf = new Map<string, Set<string>>();
    for (const [key, value] of records(run1)) {
      const g = run1.labels[key]?.group as string;
      groupsOf.set(value, (groupsOf.get(value) ?? new Set()).add(g));
    }
    for (const [, gs] of groupsOf) {
      expect(gs.size).toBe(1);
      const splits = new Set([...gs].map((g) => run1.manifest.splits[g]));
      expect(splits.size).toBe(1);
    }
  });

  it('both splits hold groups, real and negative records; counts add up', () => {
    const { dev, heldout } = run1.manifest.counts.bySplit;
    for (const s of [dev, heldout]) {
      expect(s.groups).toBeGreaterThan(0);
      expect(s.real).toBeGreaterThan(0);
      expect(s.negative).toBeGreaterThan(0);
    }
    expect(dev.records + heldout.records).toBe(run1.manifest.counts.records);
    for (const g of run1.manifest.groups) expect(run1.manifest.splits[g.id]).toBe(g.split);
  });

  it('the manifest carries no raw values', () => {
    const text = JSON.stringify(run1.manifest);
    for (const v of run1.rawOracle.reportedValues) if (v.length >= 12) expect(text.includes(v)).toBe(false);
    expect(run1.manifest.frozenAt).toBeNull();
    expect(run1.manifest.generatorVersion).toMatch(/^synth-v/);
  });
});

describe('run-2 variant', () => {
  it('keeps labels, keys and manifest identity; changes exactly two file lines', () => {
    expect(run2.labels).toEqual(run1.labels);
    expect(run2.manifest.run2).toEqual(run1.manifest.run2);
    expect(run2.manifest.variant).toBe('run2');
    let changed = 0;
    for (const [path, c1] of Object.entries(run1.files)) {
      const a = c1.split('\n');
      const b = (run2.files[path] as string).split('\n');
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
    }
    expect(changed).toBe(2);
    expect(run2.trufflehogNdjson).toBe(run1.trufflehogNdjson);
  });

  it('T19: same fingerprint, same mask shape, different value', () => {
    const key = run1.manifest.run2.replacedKey;
    const find = (r: SynthResult) => gitleaks(r).find((g) => labelKey('gitleaks', g.File, g.StartLine, g.RuleID) === key);
    const a = find(run1);
    const b = find(run2);
    expect(a && b).toBeTruthy();
    const ra = a as GitleaksRecord;
    const rb = b as GitleaksRecord;
    expect(run1.labels[key]?.trap).toBe('T19');
    expect(rb.Fingerprint).toBe(ra.Fingerprint);
    expect(rb.Secret).not.toBe(ra.Secret);
    expect(rb.Secret.length).toBe(ra.Secret.length);
    expect(rb.Secret.split('').map(charClassAt)).toEqual(ra.Secret.split('').map(charClassAt));
    expect(rb.Secret.slice(0, 4)).toBe(ra.Secret.slice(0, 4));
    expect([rb.StartLine, rb.StartColumn, rb.EndColumn, rb.RuleID]).toEqual([ra.StartLine, ra.StartColumn, ra.EndColumn, ra.RuleID]);
  });

  it('changed context: same record, the line directly above differs', () => {
    const key = run1.manifest.run2.contextChangedKey;
    const a = gitleaks(run1).find((g) => labelKey('gitleaks', g.File, g.StartLine, g.RuleID) === key) as GitleaksRecord;
    const b = gitleaks(run2).find((g) => labelKey('gitleaks', g.File, g.StartLine, g.RuleID) === key) as GitleaksRecord;
    expect(a).toBeDefined();
    expect(b).toEqual(a);
    const la = (run1.files[a.File] as string).split('\n');
    const lb = (run2.files[a.File] as string).split('\n');
    expect(lb[a.StartLine - 2]).not.toBe(la[a.StartLine - 2]);
    expect(lb[a.StartLine - 1]).toBe(la[a.StartLine - 1]);
  });

  it('all other gitleaks records are unchanged', () => {
    const k = run1.manifest.run2.replacedKey;
    const a = gitleaks(run1).filter((g) => labelKey('gitleaks', g.File, g.StartLine, g.RuleID) !== k);
    const b = gitleaks(run2).filter((g) => labelKey('gitleaks', g.File, g.StartLine, g.RuleID) !== k);
    expect(b).toEqual(a);
  });
});

describe('no-leak fixtures exist', () => {
  it('unreported, fingerprint, short-value, repeated and adjacent fixtures are present', () => {
    const o = run1.rawOracle;
    const reportText = run1.gitleaksJson + run1.trufflehogNdjson;
    expect(o.unreportedValues.length).toBeGreaterThanOrEqual(1);
    for (const v of o.unreportedValues) {
      expect(Object.values(run1.files).some((c) => c.includes(v))).toBe(true);
      expect(reportText.includes(v)).toBe(false);
    }
    expect(o.fingerprintValues.length).toBeGreaterThanOrEqual(1);
    for (const v of o.fingerprintValues) expect(gitleaks(run1).some((g) => g.Fingerprint.includes(v))).toBe(true);
    expect(o.shortValues.length).toBeGreaterThanOrEqual(1);
    for (const v of o.shortValues) expect(v.length).toBeLessThan(6);
    expect(o.repeatedValueKeys.length).toBeGreaterThanOrEqual(3);
    expect(o.adjacentPairKeys.length).toBeGreaterThanOrEqual(2);
  });
});

describe('no complete token-shaped literal in generator source (D14 static stand-in)', () => {
  const srcDir = fileURLToPath(new URL('../../src/core/synth/', import.meta.url));
  const extra = [
    fileURLToPath(new URL('../../src/core/rng.ts', import.meta.url)),
    fileURLToPath(new URL('./synth.test.ts', import.meta.url)),
    fileURLToPath(new URL('./noLeak.test.ts', import.meta.url)),
  ];
  const sources = [...readdirSync(srcDir).filter((f) => f.endsWith('.ts')).map((f) => join(srcDir, f)), ...extra]
    .map((p) => ({ p, text: readFileSync(p, 'utf8') }));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  it('scans a non-empty source set', () => {
    expect(sources.length).toBeGreaterThanOrEqual(7);
  });

  it('has no known prefix followed by 16 or more token characters', () => {
    const prefixes = knownPrefixes();
    expect(prefixes.length).toBeGreaterThanOrEqual(5);
    for (const { p, text } of sources) {
      for (const pre of prefixes) {
        const re = new RegExp(escape(pre) + '[A-Za-z0-9_\\-]{16,}');
        expect({ file: p, prefix: pre, hit: re.test(text) }).toEqual({ file: p, prefix: pre, hit: false });
      }
    }
  });

  it('does not contain the AWS documentation example pair as literals', () => {
    for (const { p, text } of sources) {
      expect({ p, hit: text.includes(awsDocsExampleKeyId()) }).toEqual({ p, hit: false });
      expect({ p, hit: text.includes(awsDocsExampleSecret()) }).toEqual({ p, hit: false });
    }
  });

  it('has no quoted literal of 32+ token characters', () => {
    const re = /['"`][A-Za-z0-9+/=_-]{32,}['"`]/;
    for (const { p, text } of sources) expect({ p, hit: re.test(text) }).toEqual({ p, hit: false });
  });

  it('the generated reports DO contain prefixed tokens (the source scan is not vacuous)', () => {
    const re = new RegExp(escape(TOKEN_SPECS.github_pat.prefix) + '[A-Za-z0-9]{36}');
    expect(re.test(run1.gitleaksJson)).toBe(true);
  });
});
