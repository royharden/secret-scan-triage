// Report emitters for the synthetic model: a gitleaks-shaped JSON array and a trufflehog-shaped NDJSON stream.
// Field names follow docs/report-formats.md, which is "from documentation, unverified against a real sample" until D1.
import type { PlacedFinding, SynthFile, SynthModel } from './generator.ts';
import { synthEntropy } from './tokens.ts';

export type SynthScanner = 'gitleaks' | 'trufflehog';

/**
 * Label key for one report record. Derivable from a masked Finding (scanner, path, line, ruleId), so the evaluation can
 * join pipeline output to labels without raw values. For trufflehog, ruleId = DetectorName and line = Filesystem.line.
 */
export function labelKey(scanner: SynthScanner, path: string, line: number, ruleId: string): string {
  return `${scanner}|${path}|${line}|${ruleId}`;
}

const RULE_DESCRIPTIONS: Record<string, string> = {
  'github-pat': 'GitHub Personal Access Token',
  'aws-access-token': 'AWS access key id',
  'slack-bot-token': 'Slack bot token',
  'stripe-access-token': 'Stripe secret key',
  'gitlab-pat': 'GitLab Personal Access Token',
  'gcp-api-key': 'GCP API key',
  'npm-access-token': 'npm access token',
  'private-key': 'Private key',
  'generic-api-key': 'Generic API key or secret',
};

interface Location {
  startColumn: number;
  endColumn: number;
  match: string;
}

/** 1-based, inclusive columns of the gitleaks Match inside the file line(s). */
export function locate(file: SynthFile, f: PlacedFinding): Location {
  const segs = f.value.split('\n');
  const first = segs[0] as string;
  const lineText = file.lines[f.line - 1];
  if (lineText === undefined) throw new Error(`synth: line ${f.line} missing in ${f.path}`);
  const idx = lineText.lastIndexOf(first);
  if (idx < 0) throw new Error(`synth: value not found on ${f.path}:${f.line}`);
  for (let k = 1; k < segs.length; k++) {
    if (file.lines[f.line - 1 + k] !== segs[k]) throw new Error(`synth: multi-line value mismatch at ${f.path}:${f.line + k}`);
  }
  if (segs.length > 1) {
    return { startColumn: idx + 1, endColumn: (segs[segs.length - 1] as string).length, match: f.value };
  }
  if (f.matchMode === 'assignment') {
    const start = lineText.search(/\S/);
    let end = idx + first.length;
    const next = lineText.charAt(end);
    if (next === '"' || next === "'") end += 1;
    const match = lineText.slice(start, end);
    return { startColumn: start + 1, endColumn: start + match.length, match };
  }
  return { startColumn: idx + 1, endColumn: idx + first.length, match: f.value };
}

function byFileOrder(a: PlacedFinding, b: PlacedFinding): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.line - b.line;
}

export interface GitleaksRecord {
  RuleID: string;
  Description: string;
  StartLine: number;
  EndLine: number;
  StartColumn: number;
  EndColumn: number;
  Match: string;
  Secret: string;
  File: string;
  SymlinkFile: string;
  Commit: string;
  Entropy: number;
  Author: string;
  Email: string;
  Date: string;
  Message: string;
  Tags: string[];
  Fingerprint: string;
}

export function gitleaksRecords(model: SynthModel): GitleaksRecord[] {
  const files = new Map(model.files.map((f) => [f.path, f]));
  const out: GitleaksRecord[] = [];
  for (const f of model.findings.filter((x) => x.gitleaksRule !== undefined).sort(byFileOrder)) {
    const rule = f.gitleaksRule as string;
    const file = files.get(f.path);
    if (file === undefined) throw new Error(`synth: file missing ${f.path}`);
    const loc = locate(file, f);
    const git = f.commit !== undefined;
    out.push({
      RuleID: rule,
      Description: RULE_DESCRIPTIONS[rule] ?? rule,
      StartLine: f.line,
      EndLine: f.endLine,
      StartColumn: loc.startColumn,
      EndColumn: loc.endColumn,
      Match: loc.match,
      Secret: f.value,
      File: f.path,
      SymlinkFile: '',
      Commit: git ? (f.commit as string) : '',
      Entropy: synthEntropy(f.value),
      Author: git ? 'Synthetic Developer' : '',
      Email: git ? 'dev@example.invalid' : '',
      Date: git ? '2026-09-15T12:00:00Z' : '',
      Message: git ? 'add service configuration' : '',
      Tags: [],
      // no-git form `file:rule:line`; git form `commit:file:rule:line`
      Fingerprint: git ? `${f.commit as string}:${f.path}:${rule}:${f.line}` : `${f.path}:${rule}:${f.line}`,
    });
  }
  return out;
}

export function emitGitleaks(model: SynthModel): string {
  return JSON.stringify(gitleaksRecords(model), null, 1);
}

export interface TrufflehogRecord {
  SourceMetadata: { Data: { Filesystem: { file: string; line: number } } };
  SourceID: number;
  SourceType: number;
  SourceName: string;
  DetectorName: string;
  DecoderName: string;
  Verified: boolean;
  Raw: string;
  RawV2: string;
  Redacted: string;
  ExtraData: null;
  StructuredData: null;
}

export function trufflehogRecords(model: SynthModel): TrufflehogRecord[] {
  const out: TrufflehogRecord[] = [];
  for (const f of model.findings.filter((x) => x.trufflehog !== undefined).sort(byFileOrder)) {
    const th = f.trufflehog as { detector: string; verified: boolean };
    out.push({
      SourceMetadata: { Data: { Filesystem: { file: f.path, line: f.line } } },
      SourceID: 1,
      SourceType: 15,
      SourceName: 'trufflehog - filesystem',
      DetectorName: th.detector,
      DecoderName: 'PLAIN',
      Verified: th.verified,
      Raw: f.value,
      RawV2: '',
      Redacted: '',
      ExtraData: null,
      StructuredData: null,
    });
  }
  return out;
}

export function emitTrufflehog(model: SynthModel): string {
  return trufflehogRecords(model).map((r) => JSON.stringify(r)).join('\n') + '\n';
}
