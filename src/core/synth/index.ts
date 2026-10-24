// Public surface of the synthetic generator (package C). See docs/core-api.md "synth/ + pipeline".
export { generateSynthetic, buildModel, GENERATOR_VERSION, DEFAULT_SIZE } from './generator.ts';
export type {
  SynthOptions,
  SynthResult,
  SynthManifest,
  SynthLabel,
  SynthRawOracle,
  SplitCounts,
  Split,
  Variant,
} from './generator.ts';
export { labelKey, gitleaksRecords, trufflehogRecords } from './emit.ts';
export type { GitleaksRecord, TrufflehogRecord, SynthScanner } from './emit.ts';
export { ALL_TRAPS, TRAP_DESCRIPTIONS } from './traps.ts';
export type { TrapId } from './traps.ts';
export { knownPrefixes, TOKEN_SPECS, awsDocsExampleKeyId, awsDocsExampleSecret } from './tokens.ts';
