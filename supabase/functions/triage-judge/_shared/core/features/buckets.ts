// Bucket boundaries and per-class entropy thresholds. Small exported constants so docs/signals.md and tests can cite them.
import type { CharClass, Features } from '../finding.ts';

/** Inclusive upper bounds on value length (code units). Anything above the last bound is 'xl'. */
export const LENGTH_BUCKETS: ReadonlyArray<{ max: number; bucket: Features['lengthBucket'] }> = Object.freeze([
  { max: 8, bucket: 'xs' },
  { max: 16, bucket: 's' },
  { max: 32, bucket: 'm' },
  { max: 64, bucket: 'l' },
]);

/** Entropy (bits/char) bounds: low < LOW_BELOW <= mid < HIGH_FROM <= high. */
export const ENTROPY_BUCKETS = Object.freeze({ LOW_BELOW: 3.0, HIGH_FROM: 4.0 });

/**
 * Base per-class entropy threshold (bits/char). A value at or above its class threshold "looks random for its class".
 * Effective threshold is length-aware (see entropyThreshold) because short strings cannot reach high entropy.
 */
export const ENTROPY_CLASS_THRESHOLDS: Readonly<Record<CharClass, number>> = Object.freeze({
  hex: 3.0,
  digits: 3.0,
  alnum: 3.7,
  base64: 4.0,
  base64url: 4.0,
  mixed: 3.7,
  pem: 4.5,
});

/** Fraction of the maximum attainable entropy (log2 of length) used for short strings. */
export const SHORT_STRING_ENTROPY_FACTOR = 0.85;

export function lengthBucket(length: number): Features['lengthBucket'] {
  for (const b of LENGTH_BUCKETS) if (length <= b.max) return b.bucket;
  return 'xl';
}

export function entropyBucket(entropy: number): Features['entropyBucket'] {
  if (!Number.isFinite(entropy) || entropy < ENTROPY_BUCKETS.LOW_BELOW) return 'low';
  if (entropy < ENTROPY_BUCKETS.HIGH_FROM) return 'mid';
  return 'high';
}

/** Length-aware class threshold: min(class base, factor * log2(length)). */
export function entropyThreshold(cls: CharClass, length: number): number {
  const base = ENTROPY_CLASS_THRESHOLDS[cls];
  if (!(length > 1)) return base;
  return Math.min(base, SHORT_STRING_ENTROPY_FACTOR * Math.log2(length));
}
