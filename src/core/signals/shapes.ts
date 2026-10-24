// Span binding helpers plus value-shape signals S-F5..S-F10.
// Span rule (T17): a signal's evidence is the finding's own span inside the raw match line ('L0'). FP-direction checks that
// depend on surrounding text must hold for EVERY occurrence of the value on the line; real-direction checks need ANY one.
import type { CitedPointer, Features, RawCandidate, SignalId } from '../finding.ts';
import type { SignalConfig } from './index.ts';

export interface Span {
  start: number;
  end: number;
}

export interface SpanContext {
  value: string;
  /** Raw match line, or null when the scanner gave none. */
  line: string | null;
  /** Occurrences inside the line, bounded by MAX_SPANS. Never assume exhaustive unless complete is true. */
  spans: Span[];
  /** False when more occurrences exist than the bounded scan retains. Incomplete evidence must route to review. */
  complete: boolean;
  /** Pointer to the first occurrence, else a line-level pointer to L0. */
  pointer: CitedPointer;
}

export interface SignalContext {
  raw: RawCandidate;
  features: Features;
  cfg: SignalConfig;
  span: SpanContext;
}

export interface SignalHit {
  id: SignalId;
  pointer: CitedPointer;
}

export const MAX_SPANS = 64;

export function scanSpans(line: string, value: string): { spans: Span[]; complete: boolean } {
  const out: Span[] = [];
  if (!value) return { spans: out, complete: true };
  let i = line.indexOf(value);
  while (i !== -1 && out.length < MAX_SPANS) {
    out.push({ start: i, end: i + value.length });
    i = line.indexOf(value, i + 1);
  }
  return { spans: out, complete: i === -1 };
}

/** Compatibility projection. Decisions must use buildSpanContext/scanSpans so exhaustion is never hidden. */
export function locateSpans(line: string, value: string): Span[] {
  return scanSpans(line, value).spans;
}

export function spanPointer(s: Span): CitedPointer {
  return { kind: 'span', lineId: 'L0', start: s.start, end: s.end };
}

export function buildSpanContext(raw: RawCandidate): SpanContext {
  const value = raw.rawValue;
  const line = typeof raw.rawLine === 'string' && raw.rawLine.length > 0 ? raw.rawLine : null;
  const { spans, complete } = line ? scanSpans(line, value) : { spans: [], complete: true };
  const first = spans[0];
  const pointer: CitedPointer = first ? spanPointer(first) : { kind: 'line', lineId: 'L0' };
  return { value, line, spans, complete, pointer };
}

/** First span when `pred` holds for every located span (and at least one exists); else null. FP-direction use. */
export function everySpan(ctx: SpanContext, pred: (s: Span, line: string) => boolean): Span | null {
  if (!ctx.complete || !ctx.line || ctx.spans.length === 0) return null;
  const line = ctx.line;
  return ctx.spans.every((s) => pred(s, line)) ? (ctx.spans[0] as Span) : null;
}

/** First span for which `pred` holds; else null. Real-direction use. */
export function someSpan(ctx: SpanContext, pred: (s: Span, line: string) => boolean): Span | null {
  if (!ctx.line) return null;
  const line = ctx.line;
  return ctx.spans.find((s) => pred(s, line)) ?? null;
}

export function textBefore(line: string, s: Span, max = 120): string {
  return line.slice(Math.max(0, s.start - max), s.start);
}

/** Effective entropy threshold for this value's class and length (shared by S-R5 and S-F9 so they never disagree). */
export function entropyThreshold(features: Features, cfg: SignalConfig): number {
  const cls = cfg.entropyThresholds[features.charClass];
  const len = Math.max(2, features.length);
  return Math.min(cls, cfg.entropyLengthFactor * Math.log2(len));
}

// ---------------------------------------------------------------- PEM (used by S-R2 in real.ts and S-F4 in sentinels.ts)

export type PemStatus = 'none' | 'full' | 'elided' | 'indeterminate';

const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]{1,40})-----/;
const PEM_END = /-----END [A-Z0-9 ]{1,40}-----/;

/**
 * full: header, base64 body of at least min_body_chars, END marker, no elision marker.
 * elided: header with empty, short or elided body (T12 truncated/docs PEM).
 * indeterminate: header with a long body but no END (possibly cut by the report) or non-base64 residue: no claim either way.
 */
export function pemStatus(text: string, cfg: SignalConfig): PemStatus {
  const m = PEM_BEGIN.exec(text);
  if (!m) return 'none';
  const after = text.slice(m.index + m[0].length);
  const endIdx = after.search(PEM_END);
  const bodyRaw = endIdx >= 0 ? after.slice(0, endIdx) : after;
  const lower = bodyRaw.toLowerCase();
  if (cfg.pem.elisionMarkers.some((mk) => lower.includes(mk))) return 'elided';
  const cleaned = bodyRaw
    .replace(/^[A-Za-z-]+:.*$/gm, '') // RFC 1421 header lines such as Proc-Type
    .replace(/\\[nr]/g, '') // escaped newlines inside source strings
    .replace(/["'+,;\s]/g, ''); // string concatenation residue and whitespace
  if (cleaned.length === 0) return 'elided';
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) return 'indeterminate';
  if (cleaned.length < cfg.pem.minBodyChars) return 'elided';
  return endIdx >= 0 ? 'full' : 'indeterminate';
}

interface PemBlock extends Span {
  bodyStart: number;
  bodyEnd: number;
}

/** Complete, label-matched, unnested blocks only. An incomplete or ambiguous block cannot prove an FP. */
function pemBlocks(text: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  const begin = new RegExp(PEM_BEGIN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = begin.exec(text)) !== null) {
    const bodyStart = m.index + m[0].length;
    const footer = `-----END ${m[1]}-----`;
    const bodyEnd = text.indexOf(footer, bodyStart);
    const nextBegin = text.indexOf('-----BEGIN ', bodyStart);
    const firstEnd = PEM_END.exec(text.slice(bodyStart));
    if (bodyEnd < 0 || (nextBegin >= 0 && nextBegin < bodyEnd)
      || !firstEnd || bodyStart + firstEnd.index !== bodyEnd) return [];
    blocks.push({ start: m.index, end: bodyEnd + footer.length, bodyStart, bodyEnd });
    begin.lastIndex = bodyEnd + footer.length;
  }
  return blocks;
}

/** Reject source-expression residue inside a block: positions between BEGIN/END alone do not prove PEM membership. */
function boundPemStatus(text: string, block: PemBlock, cfg: SignalConfig): PemStatus {
  let body = text.slice(block.bodyStart, block.bodyEnd).replace(/\\[nr]/g, '').toLowerCase();
  for (const marker of [...cfg.pem.elisionMarkers].sort((a, b) => b.length - a.length)) {
    body = body.split(marker).join('');
  }
  body = body.replace(/[()[\]]/g, ''); // wrappers around markers such as (truncated) and [REDACTED]
  if (!/^[a-z0-9+/=\s]*$/.test(body)) return 'indeterminate';
  return pemStatus(text.slice(block.start, block.end), cfg);
}

/**
 * Actual PEM evidence for this value: real evidence needs one bound full block; decisive FP evidence needs every
 * occurrence bound to an elided block. A separate literal after END, another block's status, or missing END never binds.
 */
export function pemSignalPointer(ctx: SpanContext, cfg: SignalConfig, wanted: 'full' | 'elided'): CitedPointer | null {
  if (!ctx.complete) return null;
  if (PEM_BEGIN.test(ctx.value)) {
    const value = ctx.value.trim();
    const blocks = pemBlocks(value);
    const block = blocks[0];
    if (blocks.length !== 1 || !block || block.start !== 0 || block.end !== value.length) return null;
    return boundPemStatus(value, block, cfg) === wanted ? ctx.pointer : null;
  }
  if (!ctx.line || ctx.spans.length === 0) return null;
  const line = ctx.line;
  const blocks = pemBlocks(line);
  let first: Span | undefined;
  for (const span of ctx.spans) {
    const block = blocks.find((b) => span.start >= b.bodyStart && span.end <= b.bodyEnd);
    const matches = block !== undefined && boundPemStatus(line, block, cfg) === wanted;
    if (matches) {
      if (wanted === 'full') return spanPointer(span);
      first ??= span;
    } else if (wanted === 'elided') return null;
  }
  return first ? spanPointer(first) : null;
}

// ---------------------------------------------------------------- value shapes

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT40 = /^[0-9a-f]{40}$/i;
const DATA_URI_VALUE = /^data:[\w.+/-]*(?:;[\w.+=-]+)*;base64,/i;
const DATA_URI_BEFORE = /data:[\w.+/-]*(?:;[\w.+=-]+)*;base64,[A-Za-z0-9+/=]*$/i;
/** Identifier immediately assigned to the span: name, optional closing quote/bracket, operator, optional opening quote. */
const ASSIGNED_NAME = /([A-Za-z_$][\w$.-]*)\s*["'\]]?\s*(?:=|:=|:|=>)\s*(?:[bru]?["'`])?\s*$/;
const AFFIX_PREFIXES = ['your', 'my', 'the', 'insert', 'enter', 'put'];
const AFFIX_SUFFIXES = ['goeshere', 'here', 'value', 'placeholder'];

export function isPlaceholder(value: string, cfg: SignalConfig): boolean {
  const lower = value.toLowerCase();
  return cfg.placeholderWords.some((w) => lower.includes(w)) || cfg.placeholderPatterns.some((re) => re.test(value));
}

export function isUuidOrCommit(value: string): boolean {
  return UUID.test(value) || COMMIT40.test(value);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stripAffixes(s: string): string {
  let out = s;
  for (const p of AFFIX_PREFIXES) if (out.startsWith(p) && out.length > p.length + 2) { out = out.slice(p.length); break; }
  for (const x of AFFIX_SUFFIXES) if (out.endsWith(x) && out.length > x.length + 2) { out = out.slice(0, -x.length); break; }
  return out;
}

/** Name of the identifier the span is assigned to, if any (last dotted segment). */
export function assignedName(line: string, s: Span): string | null {
  const m = ASSIGNED_NAME.exec(textBefore(line, s));
  if (!m || !m[1]) return null;
  const segs = m[1].split('.');
  return segs[segs.length - 1] ?? null;
}

export function isSelfNamed(value: string, name: string): boolean {
  const nv = stripAffixes(norm(value));
  const nn = stripAffixes(norm(name));
  return nn.length >= 3 && nv.length >= 3 && nv === nn;
}

function splitIdentifier(value: string): string[] {
  return value
    .split(/[_.-]+/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/))
    .filter((t) => t.length > 0);
}

export function isIdentifierShape(value: string, words: ReadonlySet<string>): boolean {
  if (value.length < 4 || !/^[A-Za-z]+(?:[_.-][A-Za-z]+)*$/.test(value)) return false;
  const tokens = splitIdentifier(value);
  if (tokens.length === 0) return false;
  if (tokens.every((t) => words.has(t.toLowerCase()))) return true;
  const hasStructure = /[_.-]/.test(value) || /[a-z][A-Z]/.test(value);
  return hasStructure && tokens.length >= 2 && tokens.every((t) => t.length >= 2 && /[aeiouy]/i.test(t));
}

export function evalShapeSignals(ctx: SignalContext): SignalHit[] {
  const { cfg, features, span } = ctx;
  const value = span.value;
  const hits: SignalHit[] = [];
  const at = span.pointer;

  // S-F5: placeholder words/patterns in the value itself.
  if (isPlaceholder(value, cfg)) hits.push({ id: 'S-F5', pointer: at });

  // S-F6: UUID or 40-hex commit shape of the value itself.
  if (isUuidOrCommit(value)) hits.push({ id: 'S-F6', pointer: at });

  // S-F7: value is (or every occurrence sits inside) a data:...;base64, blob.
  if (DATA_URI_VALUE.test(value)) {
    hits.push({ id: 'S-F7', pointer: at });
  } else {
    const s = everySpan(span, (sp, line) => DATA_URI_BEFORE.test(textBefore(line, sp, 400)));
    if (s) hits.push({ id: 'S-F7', pointer: spanPointer(s) });
  }

  // S-F8: value equals its own variable name (T16). Occurrences with no assignment before them (e.g. the variable name
  // itself in `API_KEY = "API_KEY"`) are neutral; any occurrence assigned to a DIFFERENT name blocks the signal.
  if (span.line) {
    const line = span.line;
    let self: Span | null = null;
    let other = false;
    for (const sp of span.spans) {
      const name = assignedName(line, sp);
      if (name === null) continue;
      if (isSelfNamed(value, name)) self = self ?? sp;
      else other = true;
    }
    if (self && !other) hits.push({ id: 'S-F8', pointer: spanPointer(self) });
  }

  if (features.charClass !== 'pem') {
    // S-F9: computed entropy below the (length-adjusted) class threshold. Scanner entropy is never used.
    if (Number.isFinite(features.entropy) && features.entropy < entropyThreshold(features, cfg)) {
      hits.push({ id: 'S-F9', pointer: at });
    }
    // S-F10: camel/snake identifier or dictionary-word tokens.
    if (isIdentifierShape(value, cfg.identifierWords)) hits.push({ id: 'S-F10', pointer: at });
  }
  return hits;
}
