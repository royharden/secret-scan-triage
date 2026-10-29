import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { buildCredDataManifest, DEFAULT_COLUMNS, isContainedPath, parseCsvRecords, parseMetadataCsv, requireLocalRun, resolveMetadataPath, safeSourceReference, validateReconciliation } from '../../scripts/build-creddata-gold.ts';
import type { MetadataRow } from '../../scripts/build-creddata-gold.ts';

const header = Object.values(DEFAULT_COLUMNS).join(',');
const options = { seed: 26, heldoutCap: 5, generatedAt: '2026-10-24T00:00:00.000Z', labelsReconciled: true, receiptSha256: 'a'.repeat(64) };
function rows(): MetadataRow[] {
  return Array.from({ length: 40 }, (_, index) => ({ candidateId: `private-candidate-${index}`, repositoryId: `private-owner/repo-${Math.floor(index / 10)}`, filePath: `private-source/file-${index}.txt`, line: 1, label: (['T', 'F', 'X'] as const)[index % 3], rowIndex: index + 1 }));
}

describe('normalized metadata CSV only', () => {
  it('parses explicit columns, BOM/CRLF/quoted commas and doubled quotes', () => {
    expect(parseCsvRecords('a,"b,b","c""d"\r\n')).toEqual([['a', 'b,b', 'c"d']]);
    expect(parseMetadataCsv(`\uFEFF${header}\r\n"id,one",org/repo,"src/a,b.ts",7,X\r\n`)).toEqual([{ candidateId: 'id,one', repositoryId: 'org/repo', filePath: 'src/a,b.ts', line: 7, label: 'X', rowIndex: 1 }]);
    const mapping = { candidateId: 'Id', repositoryId: 'Repo', filePath: 'Path', line: 'Number', label: 'Truth' };
    expect(parseMetadataCsv('Truth,Number,Path,Repo,Id\nT,3,src/a.ts,org/repo,id1\n', mapping)[0].label).toBe('T');
  });
  it('rejects guessed schemas, source-content columns, malformed records and unknown labels', () => {
    expect(() => parseMetadataCsv(`${header},source_content\nid,r,src/a.ts,1,T,never-copy\n`)).toThrow();
    expect(() => parseMetadataCsv('Id,Repo,Path,Line,GroundTruth\n')).toThrow();
    expect(() => parseMetadataCsv(`${header}\nid,r,src/a.ts,1,U\n`)).toThrow();
    expect(() => parseMetadataCsv(`${header}\n"unclosed,r,src/a.ts,1,T`)).toThrow();
    expect(() => parseMetadataCsv(`${header}\nid,r,../outside.ts,1,T\n`)).toThrow();
  });
});

describe('local execution and path containment', () => {
  it('rejects native Windows/CI and requires recorded label-rule reconciliation', () => {
    expect(() => requireLocalRun('win32', {})).toThrow();
    expect(() => requireLocalRun('linux', { CI: 'true' })).toThrow();
    expect(() => requireLocalRun('linux', {})).not.toThrow();
    expect(() => validateReconciliation(false, 'a'.repeat(64))).toThrow();
    expect(() => validateReconciliation(true, 'not-a-digest')).toThrow();
    expect(() => buildCredDataManifest([{ sha256: 'b'.repeat(64), rows: rows() }], { ...options, labelsReconciled: false })).toThrow();
  });
  it('rejects sibling-prefix paths and canonical symlink escapes without filesystem reads', async () => {
    // what_bug_this_catches: startsWith(root) accepts root-other and lexical checks alone accept a symlink escape.
    const root = resolve('dataset');
    expect(isContainedPath(root, resolve('dataset-other/labels.csv'))).toBe(false);
    expect(safeSourceReference('/outside.csv')).toBe(false);
    expect(safeSourceReference('C:\\outside.csv')).toBe(false);
    await expect(resolveMetadataPath(root, 'labels.csv', async () => resolve('outside/labels.csv'))).rejects.toThrow();
    await expect(resolveMetadataPath(root, '../outside.csv', async (path) => path)).rejects.toThrow();
    await expect(resolveMetadataPath(root, 'metadata/labels.csv', async (path) => path)).resolves.toBe(resolve(root, 'metadata/labels.csv'));
  });
});

describe('grouped natural-prevalence selection and path-free manifest', () => {
  it('splits repositories first, caps uniformly without label quotas and retains identical X-variant candidates', () => {
    const source = { sha256: 'b'.repeat(64), rows: rows() };
    const manifest = buildCredDataManifest([source], options);
    expect(buildCredDataManifest([source], options)).toEqual(manifest);
    expect(manifest.counts).toMatchObject({ population: { n: 40 }, dev: { n: 20 }, heldoutPool: { n: 20 }, heldoutSelected: { n: 5 } });
    const splits = new Map<string, Set<string>>();
    for (const selected of manifest.selected) {
      const seen = splits.get(selected.repositoryDigest) ?? new Set<string>(); seen.add(selected.split); splits.set(selected.repositoryDigest, seen);
      expect(selected.primaryReal).toBe(selected.label === 'T'); expect(selected.xAsReal).toBe(selected.label !== 'F');
    }
    expect([...splits.values()].every((seen) => seen.size === 1)).toBe(true);
    // Changing labels never changes sampling membership: there is no balancing/quota to fit an assumed true ratio.
    const relabelled = buildCredDataManifest([{ ...source, rows: source.rows.map((row) => ({ ...row, label: 'F' as const })) }], options);
    expect(relabelled.selected.map((s) => [s.sourceIndex, s.rowIndex])).toEqual(manifest.selected.map((s) => [s.sourceIndex, s.rowIndex]));
    const json = JSON.stringify(manifest);
    expect(json).not.toContain('private-owner'); expect(json).not.toContain('private-source'); expect(json).not.toContain('private-candidate');
    expect(json).not.toContain('filePath'); expect(json).not.toContain('sourceContent');
  });
  it('rejects duplicates and extra source-content fields rather than copying them', () => {
    const input = rows(); input[1].candidateId = input[0].candidateId;
    expect(() => buildCredDataManifest([{ sha256: 'b'.repeat(64), rows: input }], options)).toThrow();
    const extra = rows(); Object.assign(extra[0], { sourceContent: 'never copied' });
    expect(() => buildCredDataManifest([{ sha256: 'b'.repeat(64), rows: extra }], options)).toThrow();
  });
});
