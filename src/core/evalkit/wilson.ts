import type { Interval } from './types.ts';

/** Two-sided Wilson score interval at 95%; no trials means no estimate. */
export function wilson(successes: number, total: number): Interval | null {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(successes) || total < 0 || successes < 0 || successes > total) throw new Error('Invalid counts.');
  if (total === 0) return null;
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const divisor = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / divisor;
  const radius = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / divisor;
  return { low: Math.max(0, center - radius), high: Math.min(1, center + radius) };
}
