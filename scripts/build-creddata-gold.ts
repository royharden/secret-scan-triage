// LOCAL METADATA ONLY. Never open a metadata row's source file or emit its path, candidate id or content.
// This normalized schema is an adapter contract; it has NOT been verified against a CredData checkout.
import { createHash } from 'node:crypto';
import { access, copyFile, lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRng } from '../src/core/rng.ts';

export type CredDataLabel = 'T' | 'F' | 'X';
export interface MetadataRow {
  candidateId: string; repositoryId: string; filePath: string; line: number; label: CredDataLabel;
  /** One-based logical CSV data record, excluding the header. Not a source-file line. */
  rowIndex: number;
}
export interface ColumnMapping { candidateId: string; repositoryId: string; filePath: string; line: string; label: string }
export const DEFAULT_COLUMNS: Readonly<ColumnMapping> = Object.freeze({ candidateId: 'candidate_id', repositoryId: 'repository_id', filePath: 'file_path', line: 'line', label: 'label' });
export const MAX_METADATA_BYTES = 100_000_000;
export const MAX_HELDOUT = 5000;
type FailureCode = 'platform' | 'ci' | 'schema' | 'row' | 'label' | 'reconciliation' | 'path' | 'duplicate' | 'size' | 'arguments' | 'io';
const MESSAGES: Record<FailureCode, string> = {
  platform: 'Run locally on Linux or WSL; native Windows is unsupported.', ci: 'CredData preparation is disabled in CI.',
  schema: 'Invalid normalized CSV headers or column mapping; consult docs/creddata-manifest.md.',
  row: 'Invalid normalized metadata row.', label: 'Only T, F and X labels are accepted.',
  reconciliation: 'Recorded owner reconciliation with the dataset label rules is required.',
  path: 'Metadata containment or relative source-reference validation failed.', duplicate: 'Duplicate candidate id or repository/file/line reference.',
  size: 'Metadata exceeds the configured input bound.', arguments: 'Invalid builder arguments; consult docs/creddata-manifest.md.',
  io: 'Metadata or manifest file operation failed.',
};
export class CredDataError extends Error {
  readonly code: FailureCode;
  readonly rowIndex?: number;
  constructor(code: FailureCode, rowIndex?: number) { super(MESSAGES[code]); this.name = 'CredDataError'; this.code = code; this.rowIndex = rowIndex; }
}
const fail = (code: FailureCode, rowIndex?: number): never => { throw new CredDataError(code, rowIndex); };
const digest = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

/** RFC-style commas, quotes, doubled quotes, LF/CRLF. Metadata values themselves must be single-line. */
export function parseCsvRecords(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"') {
      if (field || closed) fail('schema');
      quoted = true;
    } else if (c === ',') { row.push(field); field = ''; closed = false; }
    else if (c === '\n' || c === '\r') {
      row.push(field); records.push(row); row = []; field = ''; closed = false;
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else { if (closed) fail('schema'); field += c; }
  }
  if (quoted) fail('schema');
  if (field || row.length || closed) { row.push(field); records.push(row); }
  return records;
}

function singleLine(value: unknown, maximum = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value); }
export function safeSourceReference(path: string): boolean {
  return singleLine(path) && !path.includes('\\') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
export function parseMetadataCsv(text: string, mapping: Readonly<ColumnMapping> = DEFAULT_COLUMNS): MetadataRow[] {
  const keys = ['candidateId', 'repositoryId', 'filePath', 'line', 'label'] as const;
  if (Object.keys(mapping).sort().join(',') !== [...keys].sort().join(',') || keys.some((key) => typeof mapping[key] !== 'string' || !singleLine(mapping[key], 128)) || new Set(Object.values(mapping)).size !== 5) fail('schema');
  const records = parseCsvRecords(text);
  if (!records.length) fail('schema');
  const header = records[0].map((value) => value.trim());
  if (header.length !== 5 || new Set(header).size !== 5 || header.some((name) => !Object.values(mapping).includes(name))) fail('schema');
  const indices = Object.fromEntries(keys.map((key) => [key, header.indexOf(mapping[key])])) as Record<typeof keys[number], number>;
  return records.slice(1).map((record, index) => {
    const rowIndex = index + 1;
    if (record.length !== 5) fail('row', rowIndex);
    const get = (key: typeof keys[number]) => record[indices[key]].trim();
    const candidateId = get('candidateId'), repositoryId = get('repositoryId'), filePath = get('filePath'), lineText = get('line'), label = get('label');
    if (!singleLine(candidateId, 512) || !singleLine(repositoryId, 512) || !/^\d{1,9}$/.test(lineText) || Number(lineText) < 1) fail('row', rowIndex);
    if (!safeSourceReference(filePath)) fail('path', rowIndex);
    if (label !== 'T' && label !== 'F' && label !== 'X') fail('label', rowIndex);
    return { candidateId, repositoryId, filePath, line: Number(lineText), label, rowIndex };
  });
}

/** Both inputs must be resolved absolute paths; strict descendants only, using a component-aware relative check. */
export function isContainedPath(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference !== '' && !isAbsolute(difference) && difference !== '..' && !difference.startsWith('../') && !difference.startsWith('..\\');
}
export function requireLocalRun(platform: string, env: Record<string, string | undefined>): void {
  if (platform !== 'linux') fail('platform');
  if (['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'TF_BUILD', 'JENKINS_URL'].some((key) => Boolean(env[key]))) fail('ci');
}
export function validateReconciliation(confirmed: boolean, receiptSha256: string): void {
  if (confirmed !== true || !/^[0-9a-f]{64}$/.test(receiptSha256)) fail('reconciliation');
}
export interface MetadataSource { sha256: string; rows: readonly MetadataRow[] }
interface SelectionInput { sourceIndex: number; row: MetadataRow }
export interface SelectedReference {
  sourceIndex: number; rowIndex: number; candidateDigest: string; repositoryDigest: string;
  label: CredDataLabel; split: 'dev' | 'heldout'; primaryReal: boolean; xAsReal: boolean;
}
export interface LabelCounts { n: number; T: number; F: number; X: number; primaryReal: number; xAsReal: number }
export interface ManifestOptions { seed: number; heldoutCap?: number; devFraction?: number; generatedAt: string; labelsReconciled: boolean; receiptSha256: string }
export interface CredDataManifest {
  schemaVersion: 1; status: 'metadata-sampled'; generatedAt: string;
  dataset: { name: 'CredData candidates (direct adapter)'; upstream: string; repositoryLicense: string; sourceFileLicenses: string; upstreamSchemaVerified: false };
  schema: { kind: 'normalized-csv-v1'; columns: string[]; nativeSchemaClaim: false };
  reconciliation: { ownerConfirmed: true; receiptSha256: string };
  sampling: { seed: number; devFraction: number; heldoutCap: number; unit: 'labelled-metadata-line'; labelStratified: false; sameCandidatesForSensitivity: true };
  sources: { sourceIndex: number; metadataSha256: string; rows: number }[];
  counts: { population: LabelCounts; dev: LabelCounts; heldoutPool: LabelCounts; heldoutSelected: LabelCounts; repositories: { total: number; dev: number; heldout: number } };
  labelPolicies: { primary: { T: true; F: false; X: false }; xAsReal: { T: true; F: false; X: true } };
  selected: SelectedReference[];
  limitations: string[];
}
function labelCounts(rows: readonly SelectionInput[]): LabelCounts {
  const counts: LabelCounts = { n: rows.length, T: 0, F: 0, X: 0, primaryReal: 0, xAsReal: 0 };
  for (const { row } of rows) counts[row.label]++;
  counts.primaryReal = counts.T; counts.xAsReal = counts.T + counts.X;
  return counts;
}

export function buildCredDataManifest(sources: readonly MetadataSource[], options: ManifestOptions): CredDataManifest {
  validateReconciliation(options.labelsReconciled, options.receiptSha256);
  const cap = options.heldoutCap ?? MAX_HELDOUT, fraction = options.devFraction ?? .5;
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff || !Number.isSafeInteger(cap) || cap < 1 || cap > MAX_HELDOUT || !Number.isFinite(fraction) || fraction <= 0 || fraction >= 1 || !Number.isFinite(Date.parse(options.generatedAt))) fail('arguments');
  const all: SelectionInput[] = [];
  const ids = new Set<string>(), references = new Set<string>(), sourceHashes = new Set<string>();
  sources.forEach((source, sourceIndex) => {
    if (!/^[0-9a-f]{64}$/.test(source.sha256) || sourceHashes.has(source.sha256)) fail('schema');
    sourceHashes.add(source.sha256);
    const rowIndices = new Set<number>();
    for (const row of source.rows) {
      // Revalidate programmatic callers too; no raw value/content field belongs to this normalized row contract.
      if (Object.keys(row).sort().join(',') !== 'candidateId,filePath,label,line,repositoryId,rowIndex' || !singleLine(row.candidateId, 512) || !singleLine(row.repositoryId, 512) || !safeSourceReference(row.filePath) || !Number.isSafeInteger(row.line) || row.line < 1 || !Number.isSafeInteger(row.rowIndex) || row.rowIndex < 1 || rowIndices.has(row.rowIndex)) fail('row');
      if (!['T', 'F', 'X'].includes(row.label)) fail('label', row.rowIndex);
      const reference = JSON.stringify([row.repositoryId, row.filePath, row.line]);
      if (ids.has(row.candidateId) || references.has(reference)) fail('duplicate', row.rowIndex);
      ids.add(row.candidateId); references.add(reference); rowIndices.add(row.rowIndex); all.push({ sourceIndex, row });
    }
  });
  const repositories = [...new Set(all.map(({ row }) => row.repositoryId))].sort();
  if (repositories.length < 2) fail('row');
  const rng = createRng(options.seed);
  const shuffled = rng.fork('repository-split').shuffle(repositories);
  const devSize = Math.min(repositories.length - 1, Math.max(1, Math.floor(repositories.length * fraction)));
  const devRepos = new Set(shuffled.slice(0, devSize));
  const dev = all.filter(({ row }) => devRepos.has(row.repositoryId));
  const heldoutPool = all.filter(({ row }) => !devRepos.has(row.repositoryId));
  // Uniform reservoir over ALL held-out metadata lines, with no T/F/X quotas. The observed ratio is not fixed.
  const selectedHeldout: SelectionInput[] = [];
  const sampler = rng.fork('heldout-reservoir');
  heldoutPool.forEach((item, index) => {
    if (index < cap) selectedHeldout.push(item);
    else { const slot = sampler.int(0, index + 1); if (slot < cap) selectedHeldout[slot] = item; }
  });
  const selected = [...dev, ...selectedHeldout].sort((a, b) => a.sourceIndex - b.sourceIndex || a.row.rowIndex - b.row.rowIndex).map(({ sourceIndex, row }): SelectedReference => ({
    sourceIndex, rowIndex: row.rowIndex, candidateDigest: digest(`candidate\u0000${row.candidateId}`), repositoryDigest: digest(`repository\u0000${row.repositoryId}`),
    label: row.label, split: devRepos.has(row.repositoryId) ? 'dev' : 'heldout', primaryReal: row.label === 'T', xAsReal: row.label !== 'F',
  }));
  return {
    schemaVersion: 1, status: 'metadata-sampled', generatedAt: options.generatedAt,
    dataset: { name: 'CredData candidates (direct adapter)', upstream: 'https://github.com/Samsung/CredData', repositoryLicense: 'Apache-2.0 per local research; current checkout not reverified', sourceFileLicenses: 'Original project licences; no source content copied', upstreamSchemaVerified: false },
    schema: { kind: 'normalized-csv-v1', columns: Object.values(DEFAULT_COLUMNS), nativeSchemaClaim: false },
    reconciliation: { ownerConfirmed: true, receiptSha256: options.receiptSha256 },
    sampling: { seed: options.seed, devFraction: fraction, heldoutCap: cap, unit: 'labelled-metadata-line', labelStratified: false, sameCandidatesForSensitivity: true },
    sources: sources.map((source, sourceIndex) => ({ sourceIndex, metadataSha256: source.sha256, rows: source.rows.length })),
    counts: { population: labelCounts(all), dev: labelCounts(dev), heldoutPool: labelCounts(heldoutPool), heldoutSelected: labelCounts(selectedHeldout), repositories: { total: repositories.length, dev: devRepos.size, heldout: repositories.length - devRepos.size } },
    labelPolicies: { primary: { T: true, F: false, X: false }, xAsReal: { T: true, F: false, X: true } }, selected,
    limitations: [
      'Metadata selection only; no source file was opened, no scanner or model was run, and no evaluation result is claimed.',
      'Normalized input is not a verified upstream schema. Owner reconciliation is an attestation recorded by receipt hash.',
      'Candidates are scanner-conditioned; obfuscated values may change format cues. No assumed natural prevalence or label quota.',
      'Repository groups are disjoint; repeated underlying values across repositories cannot be checked without source/value metadata.',
      'Reproduce using identical metadata bytes, ordered source hashes, seed and normalized mapping. No source paths or contents are in this manifest.',
    ],
  };
}

/** Injectable canonicalizer lets containment/symlink behavior be tested without reading a dataset. */
export async function resolveMetadataPath(root: string, selected: string, canonicalize: (path: string) => Promise<string> = realpath): Promise<string> {
  if (!safeSourceReference(selected) || !selected.endsWith('.csv')) fail('path');
  const lexical = resolve(root, selected);
  if (!isContainedPath(root, lexical)) fail('path');
  const actual = await canonicalize(lexical);
  if (!isContainedPath(root, actual)) fail('path'); // Also rejects final or parent symlinks escaping CREDDATA_DIR.
  return actual;
}
async function readSelectedMetadata(root: string, selected: string): Promise<MetadataSource> {
  const actual = await resolveMetadataPath(root, selected);
  const details = await stat(actual);
  if (!details.isFile()) fail('path');
  if (details.size > MAX_METADATA_BYTES) fail('size');
  const bytes = await readFile(actual); // ONLY this explicitly chosen metadata CSV, never row.filePath.
  if (bytes.byteLength > MAX_METADATA_BYTES) fail('size');
  return { sha256: digest(bytes), rows: parseMetadataCsv(bytes.toString('utf8')) };
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
export async function runCredDataBuilder(args: readonly string[], env: Record<string, string | undefined>, platform: string): Promise<void> {
  requireLocalRun(platform, env);
  const metadata: string[] = [];
  let seed = 26024, cap = MAX_HELDOUT, confirmed = false, receipt = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--labels-reconciled') confirmed = true;
    else if (['--metadata', '--seed', '--heldout-cap', '--reconciliation-sha256'].includes(arg)) {
      const value = args[++i]; if (value === undefined || value.startsWith('--')) fail('arguments');
      if (arg === '--metadata') metadata.push(value);
      else if (arg === '--seed') seed = Number(value);
      else if (arg === '--heldout-cap') cap = Number(value);
      else receipt = value;
    } else fail('arguments');
  }
  validateReconciliation(confirmed, receipt); // Fail BEFORE opening any metadata when owner reconciliation is absent.
  if (!env.CREDDATA_DIR || !metadata.length || new Set(metadata).size !== metadata.length || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff || !Number.isSafeInteger(cap) || cap < 1 || cap > MAX_HELDOUT) fail('arguments');
  const root = await realpath(env.CREDDATA_DIR);
  if (!(await stat(root)).isDirectory()) fail('path');
  const sources: MetadataSource[] = [];
  for (const selected of metadata) sources.push(await readSelectedMetadata(root, selected));
  const manifest = buildCredDataManifest(sources, { seed, heldoutCap: cap, generatedAt: new Date().toISOString(), labelsReconciled: confirmed, receiptSha256: receipt });
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/creddata-manifest.json');
  const fixtureRoot = await realpath(dirname(output));
  const projectRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (!isContainedPath(projectRoot, fixtureRoot) || fixtureRoot !== dirname(output)) fail('path');
  if (await exists(output)) {
    const existing = await lstat(output);
    if (existing.isSymbolicLink() || !existing.isFile()) fail('path');
    let suffix = 1; while (await exists(`${output}.bak-${suffix}`)) suffix++;
    await copyFile(output, `${output}.bak-${suffix}`); // Preserve every existing manifest before replacing it.
  }
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

// Imports by unit tests have no file I/O or CLI execution effects.
const invoked = process.argv[1];
if (invoked && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  void runCredDataBuilder(process.argv.slice(2), process.env, process.platform).catch((error: unknown) => {
    const known = error instanceof CredDataError ? error : new CredDataError('io');
    process.stderr.write(`CredData builder: ${MESSAGES[known.code]}${known.rowIndex === undefined ? '' : ` Data record ${known.rowIndex}.`}\n`);
    process.exitCode = 1; // Never echo an engine message, path, metadata field or source fragment.
  });
}
