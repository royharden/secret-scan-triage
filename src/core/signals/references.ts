// S-F2 reference_not_literal. Decisive only when the finding's OWN span lies inside a reference construct (trap T17:
// `process.env.TOKEN || "<literal>"` must not dismiss the literal). Constructs deliberately stop at the variable name, so a
// literal default (`os.getenv("X", "<literal>")`, `${X:-<literal>}`, `{{ x | default('<literal>') }}`) is never covered.
import { spanPointer } from './shapes.ts';
import type { Span, SignalContext, SignalHit } from './shapes.ts';

const REFERENCE_PATTERNS: ReadonlyArray<RegExp> = [
  /os\.environ\s*\[\s*["'][A-Za-z_][\w.-]*["']\s*\]/g, // os.environ["X"]
  /os\.(?:environ\.get|getenv)\s*\(\s*["'][A-Za-z_][\w.-]*["']/g, // os.getenv("X"  (stops before any default)
  /process\.env\.[A-Za-z_$][\w$]*/g, // process.env.X
  /process\.env\s*\[\s*["'][A-Za-z_][\w.-]*["']\s*\]/g, // process.env["X"]
  /import\.meta\.env\.[A-Za-z_$][\w$]*/g, // import.meta.env.X
  /System\.getenv\s*\(\s*"[A-Za-z_][\w.-]*"\s*\)/g, // Java
  /ENV\s*\[\s*["'][A-Za-z_][\w.-]*["']\s*\]/g, // Ruby ENV["X"]
  /\$\{\{\s*[A-Za-z_][\w.\s]*\}\}/g, // ${{ secrets.X }} (GitHub Actions)
  /\$\{[A-Za-z_][\w.]*\}/g, // ${VAR} (no default)
  /\{\{\s*[A-Za-z_][\w.]*\s*\}\}/g, // {{ var }} (no filters)
  /%[A-Za-z_][\w]*%/g, // %VAR%
];

export function findReferenceRanges(line: string): Span[] {
  const out: Span[] = [];
  for (const proto of REFERENCE_PATTERNS) {
    const re = new RegExp(proto.source, proto.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

/** True when the whole value is itself one reference construct. */
export function isWholeReference(value: string): boolean {
  return findReferenceRanges(value).some((r) => r.start === 0 && r.end === value.length);
}

function inside(s: Span, r: Span): boolean {
  return s.start >= r.start && s.end <= r.end;
}

export function evalReferenceSignals(ctx: SignalContext): SignalHit[] {
  const { span } = ctx;
  if (!span.complete) return [];
  if (span.line && span.spans.length > 0) {
    const ranges = findReferenceRanges(span.line);
    // Every occurrence of the value on the line must be inside some construct (fail toward "not decisive").
    if (ranges.length > 0 && span.spans.every((s) => ranges.some((r) => inside(s, r)))) {
      return [{ id: 'S-F2', pointer: spanPointer(span.spans[0] as Span) }];
    }
    return [];
  }
  // No locatable span on a line: only the value itself can prove it is a reference.
  if (isWholeReference(span.value)) return [{ id: 'S-F2', pointer: span.pointer }];
  return [];
}
