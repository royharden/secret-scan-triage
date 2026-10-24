// Context-mismatch check: file context is used only if the raw value occurs on the reported line or inside the
// window; otherwise the caller falls back to the match line with a visible "context mismatch" reason.

function firstNonEmptyLine(value: string): string {
  for (const l of value.split(/\r\n|\r|\n|\\n/)) {
    const t = l.trim();
    if (t.length > 0) return t;
  }
  return '';
}

/**
 * True if `rawValue` occurs in the given lines (joined with '\n' so multi-line values inside the window match).
 * A multi-line value longer than the window (e.g. a PEM block) matches if its first non-empty line occurs.
 */
export function valueOccursInLines(rawValue: string, lines: readonly string[]): boolean {
  if (typeof rawValue !== 'string' || rawValue.length === 0 || lines.length === 0) return false;
  const joined = lines.join('\n');
  if (joined.includes(rawValue)) return true;
  const normalizedJoined = joined.replace(/\r/g, '');
  if (normalizedJoined.includes(rawValue.replace(/\r/g, ''))) return true;
  const first = firstNonEmptyLine(rawValue);
  return first.length >= 6 && first !== rawValue && lines.some((l) => l.includes(first));
}

/**
 * Mismatch when the reported line index is outside the file, or the value is not on the reported line nor inside
 * the window [start, end] (inclusive indices into fileLines).
 */
export function isContextMismatch(
  rawValue: string,
  fileLines: readonly string[],
  lineIndex: number,
  start: number,
  end: number,
): boolean {
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= fileLines.length) return true;
  if (valueOccursInLines(rawValue, [fileLines[lineIndex]])) return false;
  return !valueOccursInLines(rawValue, fileLines.slice(start, end + 1));
}
