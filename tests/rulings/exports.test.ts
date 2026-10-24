import { describe, expect, it } from 'vitest';
import { csvCell, exportCsv } from '../../src/core/export/csv.ts';
import type { ExportRow } from '../../src/core/export/csv.ts';
import { exportGitleaksIgnore } from '../../src/core/export/gitleaksignore.ts';
import { escapeMarkdown, exportMarkdown } from '../../src/core/export/markdown.ts';
import type { Finding } from '../../src/core/finding.ts';
import { guardedSafeText } from '../../src/core/mask/leakGuard.ts';
import { bindFinding } from '../../src/core/rulings/binding.ts';
import type { RulingEvent } from '../../src/core/rulings/types.ts';
import { LeakGuardError, NOT_READY_GUARD } from '../../src/core/safe.ts';
import { eventFor, findingFor, guardFor, scope } from './fixtures.ts';

async function approved(over: Partial<Finding> = {}, ruling: Partial<RulingEvent> = {}): Promise<ExportRow> {
  const finding = findingFor(over);
  return { finding, band: 'dismiss', ruling: eventFor({ ...await bindFinding(finding), ...ruling }) };
}

describe('masked dry-run exports', () => {
  it('neutralizes formula cells, quotes delimiters and preserves masked context', async () => {
    // what_bug_this_catches: opening a CSV executes a report-controlled formula or breaks quoted/multiline cells.
    for (const start of ['=', '+', '-', '@', '\t', '\r', '  =']) expect(csvCell(`${start}command`)).toMatch(/^"'/);
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    const row = await approved({ path: '=HYPERLINK("invalid")' }, { note: '@command' });
    const csv = exportCsv([row], guardFor());
    expect(csv).toContain('"\'=HYPERLINK(""invalid"")"');
    expect(csv).toContain('"\'@command"');
    expect(csv).toContain('********');
    expect(csv.startsWith('"finding_id"')).toBe(true); // plain CSV, not a JSON-quoted string
  });
  it('escapes Markdown table syntax, links, tags and line breaks', async () => {
    // what_bug_this_catches: metadata or notes becoming active links/HTML or splitting the report table.
    const row = await approved({ path: '[click](javascript:bad)<script>|x' }, { note: 'a\nb*bold*' });
    const markdown = exportMarkdown([row], guardFor());
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('[click](');
    expect(markdown).toContain('\\[click\\]\\(javascript:bad\\)&lt;script&gt;\\|x');
    expect(markdown).toContain('a<br>b\\*bold\\*');
    expect(escapeMarkdown('`code` & <tag>')).toBe('\\`code\\` &amp; &lt;tag&gt;');
    expect(markdown.startsWith('# Masked')).toBe(true);
  });
  it('limits ignore proposals to current scope-owned human approvals and verbatim original fingerprints', async () => {
    // what_bug_this_catches: a stale/reversed/foreign/trufflehog approval writing an ignore entry.
    const allowed = await approved({ id: 'allowed', fingerprint: 'abc:src/with space.ts:sample:5' });
    const rows = [allowed,
      await approved({ id: 'reversed' }, { decision: 'real' }),
      await approved({ id: 'changed' }, { contentHash: 'c'.repeat(64) }),
      await approved({ id: 'other-owner' }, { ownerId: 'other' }),
      await approved({ id: 'other-project' }, { projectKey: 'other' }),
      await approved({ id: 'truffle', scanner: 'trufflehog', origin: 'trufflehog' }),
      await approved({ id: 'no-fingerprint', fingerprint: undefined }),
      await approved({ id: 'invalid-fingerprint', fingerprint: 'bad\nentry' }),
      await approved({ id: 'leaking', fingerprint: 'abc:danger:5' }),
    ];
    const bindings = new Map(await Promise.all(rows.map(async (row) => [row.finding.id, await bindFinding(row.finding)] as const)));
    const result = exportGitleaksIgnore(rows, bindings, scope, guardFor(['danger']));
    expect(result).toEqual({ text: 'abc:src/with space.ts:sample:5\n', included: 1, excluded: 8 });
    expect(exportCsv([rows[5], rows[6]], guardFor())).toContain('Report only:');
    expect(exportMarkdown([rows[5], rows[6]], guardFor())).toContain('Report only:');
  });
  it('guards original text before escaping and guards every final file, with reload refusal', async () => {
    // what_bug_this_catches: escaping a raw substring evades the leak guard, or a reload allows an unchecked export.
    const row = await approved({ path: 'da*ng*er' });
    const guard = guardFor(['da*ng*er']);
    expect(() => exportCsv([row], guard)).toThrow(LeakGuardError);
    expect(() => exportMarkdown([row], guard)).toThrow(LeakGuardError);
    const contextRow = await approved({ maskedWindow: [{ lineId: 'L0', text: guardedSafeText('danger', 'ui_state', guardFor()) }] });
    expect(() => exportCsv([contextRow], guardFor(['danger']))).toThrow(LeakGuardError);
    expect(() => exportMarkdown([contextRow], guardFor(['danger']))).toThrow(LeakGuardError);
    expect(() => exportCsv([], NOT_READY_GUARD)).toThrow(LeakGuardError);
    expect(() => exportMarkdown([], NOT_READY_GUARD)).toThrow(LeakGuardError);
    expect(() => exportGitleaksIgnore([], new Map(), scope, NOT_READY_GUARD)).toThrow(LeakGuardError);
    // Header collisions also fail closed, even with no rows.
    expect(() => exportCsv([], guardFor(['finding_id']))).toThrow(LeakGuardError);
  });
});
