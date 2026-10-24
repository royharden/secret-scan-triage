// Value-shape predicates shared by features, token detection and signals (pure).

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DATA_URI_B64 = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(;[a-z0-9-]+=[^;,]*)*;base64,/i;
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)(-----END \1-----|$)/;

export function isUuidShape(s: string): boolean {
  return UUID.test(s);
}

/** 40 lowercase hex: git SHA-1 commit shape. */
export function isCommitShape(s: string): boolean {
  return COMMIT.test(s);
}

/** Hex digest shapes (md5 32, sha1 40, sha256 64, sha512 128). */
export function isHexDigestShape(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s) && (s.length === 32 || s.length === 40 || s.length === 64 || s.length === 128);
}

export function isDataUriBase64(s: string): boolean {
  return DATA_URI_B64.test(s.trimStart());
}

export interface PemInfo {
  hasHeader: boolean;
  label?: string;
  /** Count of base64 body characters between header and footer (escaped "\n" sequences tolerated). */
  bodyChars: number;
  /** Header present but body empty, ellipsised ("..."), or placeholder-like. */
  elided: boolean;
}

export function pemInfo(s: string): PemInfo {
  const m = PEM_BLOCK.exec(s);
  if (!m) return { hasHeader: false, bodyChars: 0, elided: false };
  const rawBody = (m[2] ?? '').replace(/\\[nr]/g, '\n');
  const bodyLines = rawBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[A-Za-z-]+:/.test(l)); // drop Proc-Type / DEK-Info headers
  const body = bodyLines.join('');
  const b64 = body.replace(/[^A-Za-z0-9+/=]/g, '');
  const elided =
    b64.length < 64 || /\.\.\.|…|<[^>]*>|x{6,}|\*{6,}|redacted|example|placeholder/i.test(body);
  return { hasHeader: true, label: m[1], bodyChars: b64.length, elided };
}

/** All one repeated character (e.g. "xxxxxxxx", "00000000"). */
export function isRepeatedChar(s: string): boolean {
  return s.length > 1 && /^(.)\1+$/s.test(s);
}

/**
 * Identifier / word shape: camelCase, PascalCase, snake_case, kebab-case or SCREAMING_CASE made of word humps.
 * Random tokens split into many 1-2 char humps; identifiers average >= 3 letters per hump.
 */
export function isIdentifierShape(s: string): boolean {
  if (typeof s !== 'string' || s.length < 4) return false;
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(s)) return false;
  // An unseparated run with no lowercase letter (e.g. upper+digit key material) is not an identifier.
  if (!/[a-z]/.test(s) && !/[_.-]/.test(s)) return false;
  const parts = s.split(/[_.-]+/).filter((p) => p.length > 0);
  let humps = 0;
  let letters = 0;
  let longDigitRuns = 0;
  for (const part of parts) {
    const found = part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g) ?? [];
    if (found.join('') !== part) return false;
    for (const h of found) {
      if (/^[0-9]+$/.test(h)) {
        if (h.length > 4) longDigitRuns++;
        continue;
      }
      humps++;
      letters += h.length;
    }
  }
  if (humps === 0 || longDigitRuns > 0) return false;
  return letters / humps >= 3;
}

/**
 * A slash-separated run whose every segment is a plain word (lower/kebab/snake, or camel/Pascal humps, optional
 * trailing digits): a file path, not base64.
 */
export function isPathLike(s: string): boolean {
  if (!s.includes('/')) return false;
  const segs = s.split('/').filter((x) => x.length > 0);
  if (segs.length < 2) return false;
  return segs.every(
    (seg) => /^[A-Za-z][a-z]*(?:[A-Z][a-z]+)*[0-9]*$/.test(seg) || /^[a-z]+(?:[_-][a-z]+)*[0-9]*$/.test(seg),
  );
}
