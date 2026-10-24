// Decisive FP proofs other than references: S-F1 documented sentinel, S-F3 lockfile integrity, S-F4 elided PEM.
import { everySpan, pemSignalPointer, spanPointer, textBefore } from './shapes.ts';
import type { SignalContext, SignalHit } from './shapes.ts';

const SRI_VALUE = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const GOSUM_VALUE = /^h1:[A-Za-z0-9+/]+={0,2}$/;
/** Text immediately before the span introduces an integrity/checksum hash. */
const INTEGRITY_BEFORE = /(?:integrity|checksum)["']?\s*[:=]?\s*["']?(?:sha(?:1|256|384|512)-|h1:)?$/i;

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

export function isLockfilePath(ctx: SignalContext): boolean {
  return ctx.features.pathClass === 'lockfile' || ctx.cfg.lockfileBasenames.includes(basename(ctx.raw.path));
}

export function evalSentinelSignals(ctx: SignalContext): SignalHit[] {
  const { cfg, span } = ctx;
  const hits: SignalHit[] = [];

  // S-F1: exact match against the fixed sentinel list (no trimming, no case folding).
  if (cfg.sentinels.has(span.value)) hits.push({ id: 'S-F1', pointer: span.pointer });

  // S-F3: integrity hash in a lockfile path, bound to the span (value shape, or every occurrence follows `integrity`).
  if (isLockfilePath(ctx)) {
    if (SRI_VALUE.test(span.value) || GOSUM_VALUE.test(span.value)) {
      hits.push({ id: 'S-F3', pointer: span.pointer });
    } else {
      const s = everySpan(span, (sp, line) => INTEGRITY_BEFORE.test(textBefore(line, sp, 80)));
      if (s) hits.push({ id: 'S-F3', pointer: spanPointer(s) });
    }
  }

  // S-F4: PEM header with no, short or elided body, bound to this finding.
  const pemPointer = pemSignalPointer(span, cfg, 'elided');
  if (pemPointer !== null) hits.push({ id: 'S-F4', pointer: pemPointer });
  return hits;
}
