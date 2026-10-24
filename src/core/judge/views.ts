// MaskedView / LlmOnlyView builders (Claude §2.6). Input is an already-masked Finding; output never exceeds 4 KiB
// serialised UTF-8. Oversized windows shrink line by line (farthest from L0 first); if the view is still too large -> null
// (the caller routes the finding to review). Full paths stay in the browser: only the basename is included.
// Every outbound use still goes through serializeSafe, which re-checks the whole view with the leak guard.
import type { Finding, MaskedLine } from '../finding.ts';
import { safeBasename } from '../mask/mask.ts';
import { MAX_VIEW_BYTES } from './contract.ts';
import type { MaskedView } from './contract.ts';

/** 'L0' -> 0, 'L-2' -> -2, 'L+1' -> 1; null for anything else. */
export function lineOffset(lineId: string): number | null {
  const m = /^L(0|[+-][1-9][0-9]*)$/.exec(lineId);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

export function viewBytes(view: MaskedView): number {
  return new TextEncoder().encode(JSON.stringify(view)).length;
}

function sortedWindow(lines: ReadonlyArray<MaskedLine>, radius: number): MaskedLine[] {
  return lines
    .map((l) => ({ l, off: lineOffset(l.lineId) }))
    .filter((x): x is { l: MaskedLine; off: number } => x.off !== null && Math.abs(x.off) <= radius)
    .sort((a, b) => a.off - b.off)
    .map((x) => x.l);
}

/** Drops the line farthest from L0 (ties: the later line) until the view fits; never drops L0. */
export function shrinkToFit(view: MaskedView, maxBytes: number = MAX_VIEW_BYTES): MaskedView | null {
  let current: MaskedView = { ...view, maskedWindow: [...view.maskedWindow] };
  while (viewBytes(current) > maxBytes) {
    const removable = current.maskedWindow
      .map((l, i) => ({ i, off: lineOffset(l.lineId) ?? 0 }))
      .filter((x) => x.off !== 0);
    if (removable.length === 0) return null;
    removable.sort((a, b) => Math.abs(b.off) - Math.abs(a.off) || b.off - a.off);
    const drop = (removable[0] as { i: number }).i;
    current = { ...current, maskedWindow: current.maskedWindow.filter((_, i) => i !== drop) };
  }
  return current;
}

function baseView(f: Finding, window: MaskedLine[], signalBuckets: string[]): MaskedView {
  const l0 = window.find((l) => l.lineId === 'L0');
  return {
    findingId: f.id,
    ruleId: f.ruleId,
    pathClass: f.features.pathClass,
    // f.path was guard-checked (or masked/withheld) by runPipeline; safeBasename (mask/) brands its basename. The
    // outbound serializeSafe check still covers it like every other field.
    basename: safeBasename(f.path),
    maskedLine: l0 ? l0.text : f.maskedValue,
    maskedWindow: window,
    lengthBucket: f.features.lengthBucket,
    entropyBucket: f.features.entropyBucket,
    charClass: f.charClass,
    signalBuckets,
    scannerVerified: f.verified === 'verified',
  };
}

export function signalBucketsOf(f: Finding): string[] {
  return Array.from(new Set(f.signals.map((s) => `${s.id}:${s.direction}:${s.strength}`)));
}

/** Pipeline view: up to the full (<= 7 line) window plus signal buckets. Null when it cannot fit in 4 KiB. */
export function buildMaskedView(f: Finding): MaskedView | null {
  return shrinkToFit(baseView(f, sortedWindow(f.maskedWindow, 3), signalBucketsOf(f)));
}

/** LLM-only baseline view: masked match line +/-1 (three lines), no signal buckets, no deterministic stage. */
export function buildLlmOnlyView(f: Finding): MaskedView | null {
  return shrinkToFit(baseView(f, sortedWindow(f.maskedWindow, 1), []));
}
