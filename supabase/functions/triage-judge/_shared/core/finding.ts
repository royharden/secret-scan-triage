// Shared seam contract for the core library (secretnorm). Types only plus tiny pure helpers.
// Every module in src/core builds against these names; change them only with an integrator note in PLAN.md.
import type { SafeText } from './safe.ts';

export type Scanner = 'gitleaks' | 'trufflehog';

/** Policy only distinguishes verified from unknown. `Verified:false`, missing, or verification disabled are all 'unknown'. */
export type Verified = 'verified' | 'unknown';

/** Display label only; never consulted by policy. */
export type VerifiedLabel = 'verified' | 'unknown' | 'unverified';

export type CharClass = 'hex' | 'base64' | 'base64url' | 'alnum' | 'digits' | 'mixed' | 'pem';

export type PathClass = 'test' | 'fixture' | 'docs' | 'lockfile' | 'source' | 'config' | 'other';

/** Evidence pointer bound to the finding's span (start/end are offsets in the raw match line, computed in the worker). */
export interface CitedPointer {
  kind: 'span' | 'line';
  /** Line id inside the masked window ('L0' = match line, 'L-1', 'L+2', ...). */
  lineId: string;
  start?: number;
  end?: number;
}

/**
 * Ephemeral raw candidate. Exists ONLY inside the parse worker or the Node eval process.
 * Never stored in React state, IndexedDB, Supabase, logs, caches or exports.
 */
export interface RawCandidate {
  scanner: Scanner;
  ruleId: string;
  path: string;
  line: number;
  commit?: string;
  fingerprint?: string;
  rawValue: string;
  /** Raw match line as reported (gitleaks `Match`/`Line`, trufflehog `Raw` context when present). */
  rawLine?: string;
  scannerEntropy?: number;
  verifiedRaw?: boolean;
  /** Index in the source report, used for error locations. */
  recordIndex: number;
}

/** Computed features (from raw, inside the worker). Safe to keep: no raw substrings. */
export interface Features {
  length: number;
  charClass: CharClass;
  entropy: number;
  lengthBucket: 'xs' | 's' | 'm' | 'l' | 'xl';
  entropyBucket: 'low' | 'mid' | 'high';
  pathClass: PathClass;
}

export type SignalId =
  | 'S-R1' | 'S-R2' | 'S-R3' | 'S-R4' | 'S-R5'
  | 'S-F1' | 'S-F2' | 'S-F3' | 'S-F4' | 'S-F5' | 'S-F6' | 'S-F7' | 'S-F8' | 'S-F9' | 'S-F10' | 'S-F11';

export interface Signal {
  id: SignalId;
  name: string;
  direction: 'real' | 'fp';
  strength: 'decisive' | 'strong' | 'weak';
  evidence: CitedPointer;
  /** true when the signal may only downgrade (S-F11). */
  downgradeOnly?: boolean;
}

export interface Flags {
  injection: boolean;
  malformedEvidence: boolean;
  contextMismatch: boolean;
  unmaskableContext: boolean;
}

export interface MaskedLine {
  lineId: string;
  text: SafeText;
}

/** Normalised, masked finding. Everything here is safe to persist/export after serializeSafe. */
export interface Finding {
  /** Sanitised scanner fingerprint, else full HMAC-SHA256(projectSalt, ruleId|path|line|rawValue) hex. */
  id: string;
  scanner: Scanner;
  origin: Scanner;
  ruleId: string;
  path: string;
  line: number;
  commit?: string;
  /** Original scanner fingerprint, only if it passed the leak guard. Used for .gitleaksignore. */
  fingerprint?: string;
  maskedValue: SafeText;
  // keptPrefix is deliberately NOT a field: it is visible in maskedValue, and a bare prefix string would trip the leak guard.
  length: number;
  charClass: CharClass;
  /** Display only. Never FP evidence. */
  scannerEntropy?: number;
  verified: Verified;
  verifiedLabel: VerifiedLabel;
  /** Full HMAC-SHA256(projectSalt, "value"|rawValue) hex: private keyed change tag. */
  valueTag: string;
  features: Features;
  signals: Signal[];
  flags: Flags;
  maskedWindow: MaskedLine[];
}

export type Band = 'keep' | 'review' | 'dismiss';
export type Stage1Outcome = Band | 'unresolved';

export const ZERO_FLAGS: Flags = Object.freeze({
  injection: false,
  malformedEvidence: false,
  contextMismatch: false,
  unmaskableContext: false,
});
