// Safe-text brand, outbound boundaries and the single outbound serialiser (secretnorm).
// Pure TS: no DOM, no Node APIs.

/** Text that has passed masking or the leak guard. Constructible only through src/core/mask/*. */
export type SafeText = string & { readonly __safe: unique symbol };

/** Every place data may leave the parse worker / eval process. */
export type Boundary =
  | 'judge_request'
  | 'function_request'
  | 'ledger'
  | 'log'
  | 'import_error'
  | 'export'
  | 'rulings_idb'
  | 'rulings_cloud'
  | 'cache'
  | 'model_text'
  | 'ui_state'
  | 'note';

export const BOUNDARIES: readonly Boundary[] = Object.freeze([
  'judge_request',
  'function_request',
  'ledger',
  'log',
  'import_error',
  'export',
  'rulings_idb',
  'rulings_cloud',
  'cache',
  'model_text',
  'ui_state',
  'note',
] as Boundary[]);

/**
 * Brand a string as safe WITHOUT checking it.
 * Only src/core/mask/*.ts may call this (eslint no-restricted-syntax rule + review).
 */
export function unsafeMarkSafe(s: string): SafeText {
  return s as SafeText;
}

export type LeakGuardReason = 'leak' | 'not_ready' | 'unserializable';

export interface LeakGuardErrorOptions {
  findingId?: string;
  reason?: LeakGuardReason;
  /**
   * Legacy option name: only controls retaining the id as an INTERNAL structured field; the public message is empty.
   * Defaults to false. Only a ready guard that has separately checked the id may pass true.
   */
  showIdInMessage?: boolean;
}

/**
 * Thrown by LeakGuard.check / serializeSafe. Public message and string conversion are always empty: even fixed
 * boilerplate can match a known value. name/boundary/reason/stack/findingId are INTERNAL diagnostics, not safe text;
 * any displayed or emitted details must pass serializeSafe with a ready guard, or be omitted.
 */
export class LeakGuardError extends Error {
  boundary: Boundary;
  declare findingId?: string;
  reason: LeakGuardReason;

  constructor(boundary: Boundary, opts: LeakGuardErrorOptions = {}) {
    const reason: LeakGuardReason = opts.reason ?? 'leak';
    const id = opts.findingId;
    const show = typeof id === 'string' && opts.showIdInMessage === true;
    super('');
    this.name = 'LeakGuardError';
    this.boundary = boundary;
    if (show) this.findingId = id;
    this.reason = reason;
  }

  override toString(): string {
    return ''; // Implicit error-to-text conversion must not expose the unguarded diagnostic name either.
  }
}

export interface LeakGuard {
  readonly ready: boolean;
  /** Throws LeakGuardError if `text` contains known secret material. `findingId` is an internal diagnostic only. */
  check(text: string, boundary: Boundary, findingId?: string): void;
  /**
   * Compatibility no-op, always returns 0. Every digest is scanned under the same strict known-value rule;
   * only a listed provider prefix at its kept position may be exempted.
   */
  exemptDigests(hexes: readonly string[]): number;
}

/**
 * JSON.stringify(value) then guard.check — the ONLY outbound path. Checks both the serialised text and every
 * string leaf/key (so JSON escaping cannot hide a value). Throws LeakGuardError; never returns unchecked text.
 */
export function serializeSafe(value: unknown, boundary: Boundary, guard: LeakGuard, findingId?: string): string {
  if (!guard || guard.ready !== true) {
    throw new LeakGuardError(boundary, { findingId, reason: 'not_ready' });
  }
  const leaves: string[] = [];
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (key: string, v: unknown) => {
      if (key !== '') leaves.push(key);
      if (typeof v === 'string') leaves.push(v);
      return v;
    });
  } catch {
    // Cycles, BigInt, throwing toJSON: fail closed with no public message (never the engine message).
    throw new LeakGuardError(boundary, { findingId, reason: 'unserializable' });
  }
  const text = json === undefined ? 'null' : json;
  guard.check(text, boundary, findingId);
  if (leaves.length > 0) guard.check(leaves.join('\u0000'), boundary, findingId);
  return text;
}

/** Guard used after reload before re-import: ready=false and check() always throws (forces re-import). */
export const NOT_READY_GUARD: LeakGuard = Object.freeze({
  ready: false,
  check(_text: string, boundary: Boundary, findingId?: string): void {
    throw new LeakGuardError(boundary, { findingId, reason: 'not_ready' });
  },
  exemptDigests(_hexes: readonly string[]): number {
    return 0; // fail closed: nothing is exempted before re-import
  },
});
