// Synthetic token builders. Every real-format token is RANDOM and NEVER VALID (never issued by any provider; GitHub-style
// checksums are not computed), and is ASSEMBLED AT RUN TIME from split parts: no source line in this repo holds a complete
// token-shaped literal (PLAN M1 acceptance ii, Claude §5.4, D14). That includes the documented AWS example key pair, which
// is rebuilt from fragments below. Do not "simplify" the joins into single literals.
import type { Rng } from '../rng.ts';

export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const ALNUM = UPPER + LOWER + DIGITS;
export const UPPER_DIGITS = UPPER + DIGITS;
export const HEX = '0123456789abcdef';
export const B64 = ALNUM + '+/';
export const B64URL = ALNUM + '-_';
/** Password-ish alphabet: no quotes, backslashes, spaces or '#' (keeps lines parseable and comments unambiguous). */
export const PASSWORD_CHARS = ALNUM + '!$%&*+-=?@^_';

/** Join fragments. Exists so that a reader sees intent: prefixes are never written as one literal. */
const j = (...parts: string[]): string => parts.join('');

export type TokenKind =
  | 'github_pat'
  | 'aws_access_key_id'
  | 'slack_bot'
  | 'stripe_live'
  | 'gitlab_pat'
  | 'gcp_api_key'
  | 'npm_token';

export interface TokenSpec {
  kind: TokenKind;
  /** gitleaks-style rule id used in the synthetic gitleaks report. */
  gitleaksRule: string;
  /** trufflehog-style DetectorName, when the synthetic trufflehog report may also carry this kind. */
  trufflehogDetector?: string;
  /** Fixed provider prefix (assembled from parts). */
  prefix: string;
  /** Total token length including the prefix (fixed-length kinds only; Slack is variable). */
  length?: number;
  build(rng: Rng): string;
}

export const TOKEN_SPECS: Record<TokenKind, TokenSpec> = {
  github_pat: {
    kind: 'github_pat',
    gitleaksRule: 'github-pat',
    trufflehogDetector: 'Github',
    prefix: j('gh', 'p', '_'),
    length: 40,
    build: (rng) => j('gh', 'p', '_') + rng.chars(ALNUM, 36),
  },
  aws_access_key_id: {
    kind: 'aws_access_key_id',
    gitleaksRule: 'aws-access-token',
    trufflehogDetector: 'AWS',
    prefix: j('AK', 'IA'),
    length: 20,
    build: (rng) => j('AK', 'IA') + rng.chars(UPPER_DIGITS, 16),
  },
  slack_bot: {
    kind: 'slack_bot',
    gitleaksRule: 'slack-bot-token',
    trufflehogDetector: 'Slack',
    prefix: j('xo', 'xb', '-'),
    build: (rng) =>
      j('xo', 'xb', '-') + rng.chars(DIGITS, 11) + '-' + rng.chars(DIGITS, 12) + '-' + rng.chars(ALNUM, 24),
  },
  stripe_live: {
    kind: 'stripe_live',
    gitleaksRule: 'stripe-access-token',
    trufflehogDetector: 'Stripe',
    prefix: j('sk', '_li', 've_'),
    length: 32,
    build: (rng) => j('sk', '_li', 've_') + rng.chars(ALNUM, 24),
  },
  gitlab_pat: {
    kind: 'gitlab_pat',
    gitleaksRule: 'gitlab-pat',
    trufflehogDetector: 'Gitlab',
    prefix: j('gl', 'pat', '-'),
    length: 26,
    build: (rng) => j('gl', 'pat', '-') + rng.chars(ALNUM + '_-', 20),
  },
  gcp_api_key: {
    kind: 'gcp_api_key',
    gitleaksRule: 'gcp-api-key',
    prefix: j('AI', 'za'),
    length: 39,
    build: (rng) => j('AI', 'za') + rng.chars(B64URL, 35),
  },
  npm_token: {
    kind: 'npm_token',
    gitleaksRule: 'npm-access-token',
    trufflehogDetector: 'NpmToken',
    prefix: j('np', 'm', '_'),
    length: 40,
    build: (rng) => j('np', 'm', '_') + rng.chars(ALNUM, 36),
  },
};

export const TOKEN_KINDS: TokenKind[] = Object.keys(TOKEN_SPECS) as TokenKind[];

/** Known prefixes, for tests that grep source for token-shaped literals. */
export function knownPrefixes(): string[] {
  return TOKEN_KINDS.map((k) => TOKEN_SPECS[k].prefix);
}

export function buildToken(kind: TokenKind, rng: Rng): string {
  return TOKEN_SPECS[kind].build(rng);
}

// ---- Documented example values (T01). Public documentation sentinels, rebuilt from fragments. ----

/** The AWS documentation example access key id, assembled from parts. */
export function awsDocsExampleKeyId(): string {
  return j('AK', 'IA', 'IOSFO', 'DNN7', 'EXA', 'MPLE');
}

/** The AWS documentation example secret access key, assembled from parts. */
export function awsDocsExampleSecret(): string {
  return j('wJalr', 'XUtnFEMI', '/K7MDENG', '/bPxRfiCY', 'EXAMPLE', 'KEY');
}

// ---- Generic secret and non-secret shapes ----

export function highEntropyPassword(rng: Rng, length = 20): string {
  // Guarantee at least one of each class so the class/entropy signals see a "mixed" value.
  let s = rng.chars(UPPER, 1) + rng.chars(LOWER, 1) + rng.chars(DIGITS, 1) + rng.chars('!$%&*+-=?@^_', 1);
  s += rng.chars(PASSWORD_CHARS, Math.max(0, length - 4));
  return rng.shuffle(s.split('')).join('');
}

export function hexString(rng: Rng, length: number): string {
  return rng.chars(HEX, length);
}

export function base64String(rng: Rng, length: number): string {
  return rng.chars(B64, length);
}

export function base64UrlString(rng: Rng, length: number): string {
  return rng.chars(B64URL, length);
}

export function uuidV4(rng: Rng): string {
  const h = (n: number) => rng.chars(HEX, n);
  return `${h(8)}-${h(4)}-4${h(3)}-${rng.pick(['8', '9', 'a', 'b'])}${h(3)}-${h(12)}`;
}

export function commitSha(rng: Rng): string {
  return rng.chars(HEX, 40);
}

/** npm lockfile integrity value: "sha512-" + 86 base64 chars + "==" (64-byte digest shape). */
export function lockfileIntegrity(rng: Rng): string {
  return j('sha', '512-') + rng.chars(B64, 86) + '==';
}

/** A data URI with a PNG-looking base64 payload. */
export function dataUriPng(rng: Rng, payloadLength = 96): string {
  return j('data:image/png', ';base64,', 'iVBORw0KGgo') + rng.chars(B64, payloadLength);
}

const PEM_TYPES = ['RSA PRIVATE KEY', 'PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY'] as const;

function pemHeader(type: string): string {
  return j('-----', 'BEGIN ', type, '-----');
}

function pemFooter(type: string): string {
  return j('-----', 'END ', type, '-----');
}

/** A full PEM block (random body, never a valid key): header, `bodyLines` x 64 chars, a shorter last line, footer. */
export function pemFull(rng: Rng, bodyLines = 12): string[] {
  const type = rng.pick(PEM_TYPES);
  const lines = [pemHeader(type)];
  for (let i = 0; i < bodyLines; i++) lines.push(rng.chars(B64, 64));
  lines.push(rng.chars(B64, 24) + '==');
  lines.push(pemFooter(type));
  return lines;
}

/** An elided PEM block as seen in docs: header, a short stub or ellipsis, footer. */
export function pemElided(rng: Rng): string[] {
  const type = rng.pick(PEM_TYPES);
  const middle = rng.pick([['...'], [j('MIIE', 'pAIBAAKCAQEA'), '...'], ['<paste key material here>'], ['(truncated)']]);
  return [pemHeader(type), ...middle, pemFooter(type)];
}

// ---- Placeholders, dummies and self-named values ----
// Vocabulary note: the leak guard blocks any output holding a 6-character substring of a raw value, so word-like values
// that share 6-grams with synthetic file paths (client, service, tests, settings, config, ...) would needlessly mask
// those paths, and values sharing 6-grams with rule ids (generic-api-key, *-access-token, private-key) would block every
// artefact of that rule. These lists avoid such words; realistic collisions still occur via hex/base64 values (D10).

export const PLACEHOLDER_VALUES: readonly string[] = [
  'your_api_key_here',
  'changeme',
  'xxxxxxxxxxxxxxxxxxxxxxxx',
  '<token>',
  'REDACTED',
  'example_key_0000',
  'dummy_value_here',
  'replace-with-your-secret',
  'YOUR_SECRET_HERE',
];

export const TEST_DUMMY_VALUES: readonly string[] = [
  'test-password',
  'fake_key_for_unit_specs',
  'dummy',
  'not-a-real-secret',
  'testtoken123',
  'secret-for-unit-tests',
];

/** [variable name, value] pairs where the value is the variable's own name (T16). */
export const SELF_NAMED: readonly (readonly [string, string])[] = [
  ['API_KEY', 'API_KEY'],
  ['password', 'password'],
  ['SECRET_TOKEN', 'SECRET_TOKEN'],
  ['authToken', 'authToken'],
  ['SIGNING_KEY', 'SIGNING_KEY'],
  ['DB_PASSWORD', 'db_password'],
];

/** Low-entropy, identifier-shaped values that scanners sometimes flag. */
export const IDENTIFIER_VALUES: readonly string[] = [
  'billingWebhookRouter',
  'defaultSessionHandler',
  'user_profile_cache_key',
  'internalMetricsExporter',
  'order_events_consumer',
  'primaryReadReplicaHost',
];

/**
 * Replace a value with another of the SAME length and the same character class at every position after `keepPrefix`
 * characters (T19: same fingerprint, same mask shape, different value). Guaranteed different from the input.
 */
export function sameShapeReplacement(value: string, keepPrefix: number, rng: Rng): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    let out = value.slice(0, keepPrefix);
    for (let i = keepPrefix; i < value.length; i++) {
      const c = value.charAt(i);
      if (UPPER.includes(c)) out += rng.chars(UPPER, 1);
      else if (LOWER.includes(c)) out += rng.chars(LOWER, 1);
      else if (DIGITS.includes(c)) out += rng.chars(DIGITS, 1);
      else out += c;
    }
    if (out !== value) return out;
  }
  throw new Error('sameShapeReplacement: could not produce a different value');
}

/** Shannon entropy (bits per char) over code units. Used only to fill the synthetic gitleaks `Entropy` field. */
export function synthEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 10000) / 10000;
}
