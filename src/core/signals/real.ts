// Real-direction signals S-R1..S-R5.
import { entropyThreshold, pemSignalPointer, someSpan, spanPointer, textBefore } from './shapes.ts';
import type { SignalContext, SignalHit } from './shapes.ts';
import { matchProviderFormat } from '../mask/mask.ts';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const assignmentCache = new WeakMap<ReadonlyArray<string>, RegExp>();

/** Credential keyword (possibly inside a longer identifier) assigned directly to the text that follows. */
export function keywordAssignmentRe(keywords: ReadonlyArray<string>): RegExp {
  let re = assignmentCache.get(keywords);
  if (!re) {
    const alt = keywords.map(escapeRe).join('|');
    re = new RegExp(`(?:${alt})[\\w.$-]*["'\\]]?\\s*(?:=|:=|:|=>|\\+=)\\s*(?:[bru]?["'\`])?\\s*$`, 'i');
    assignmentCache.set(keywords, re);
  }
  return re;
}

export function evalRealSignals(ctx: SignalContext): SignalHit[] {
  const { raw, features, cfg, span } = ctx;
  const hits: SignalHit[] = [];

  // S-R1: scanner says Verified:true (trufflehog). Missing / false is "unknown", never evidence either way.
  if (raw.verifiedRaw === true) hits.push({ id: 'S-R1', pointer: span.pointer });

  // S-R2: complete, non-elided PEM body bound to this finding.
  const pemPointer = pemSignalPointer(span, cfg, 'full');
  if (pemPointer !== null) hits.push({ id: 'S-R2', pointer: pemPointer });

  // S-R3: fixed-prefix provider format from config/prefixes.json: prefix at value start, length bounds and charset.
  if (matchProviderFormat(span.value, cfg.providerFormats) !== undefined) hits.push({ id: 'S-R3', pointer: span.pointer });

  // S-R4: rule id on the high-precision list.
  if (cfg.highPrecisionRules.includes(raw.ruleId.toLowerCase())) hits.push({ id: 'S-R4', pointer: span.pointer });

  // S-R5: credential keyword assigned to this span AND code-computed entropy at/above the class threshold.
  if (Number.isFinite(features.entropy) && features.entropy >= entropyThreshold(features, cfg)) {
    const re = keywordAssignmentRe(cfg.credentialKeywords);
    const s = someSpan(span, (sp, line) => re.test(textBefore(line, sp)));
    if (s) hits.push({ id: 'S-R5', pointer: spanPointer(s) });
  }
  return hits;
}
