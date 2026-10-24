// Report-path normalisation and suffix matching against a user-selected folder's file list (pure).
// The report path is only a lookup key; it never opens anything by itself.

/**
 * Normalise a report path to forward-slash, relative segments. Returns null for unsafe input: empty, control
 * characters, URL schemes, '..' segments (traversal), or Windows device/stream syntax inside segments.
 * Leading '/', './' and a drive letter are dropped (absolute CI paths are matched by suffix).
 */
export function normalizeReportPath(p: string): string | null {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (s.length === 0 || s.length > 4096) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  s = s.replace(/\\/g, '/');
  s = s.replace(/^[A-Za-z]:(?=\/|$)/, '');
  const segments: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    if (seg.includes(':')) return null;
    if (/[<>"|?*]/.test(seg)) return null;
    segments.push(seg);
  }
  return segments.length === 0 ? null : segments.join('/');
}

function segmentsOf(normalized: string): string[] {
  return normalized.split('/');
}

/** Number of trailing segments two segment lists share. */
function commonSuffixLength(a: string[], b: string[]): number {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}

/**
 * Longest unique path-suffix match. Returns the matching entry of `filePaths` (as given), 'ambiguous' when several
 * files tie for the longest suffix, or null when the report path is unsafe or no file shares its basename.
 */
export function matchPathSuffix(reportPath: string, filePaths: string[]): string | 'ambiguous' | null {
  const norm = normalizeReportPath(reportPath);
  if (norm === null) return null;
  const want = segmentsOf(norm);
  let best = 0;
  let winner: string | null = null;
  let tie = false;
  for (const fp of filePaths) {
    const n = normalizeReportPath(fp);
    if (n === null) continue;
    const k = commonSuffixLength(want, segmentsOf(n));
    if (k === 0) continue;
    if (k > best) {
      best = k;
      winner = fp;
      tie = false;
    } else if (k === best) {
      tie = true;
    }
  }
  if (winner === null) return null;
  return tie ? 'ambiguous' : winner;
}
