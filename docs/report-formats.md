# Supported report formats

> **Status: from documentation, unverified against a real sample.** Every field name, type and fingerprint form below comes from
> scanner documentation and prior-art reading, not from running gitleaks or trufflehog. It stays marked this way until D1 runs
> (`docs/DEFERRED-VALIDATION.md`): run both scanners on a synthetic repo, diff the keys, then update this page.
> Parsers tolerate missing optional fields and count which were absent (`missingFields`).

Limits (both formats): reject above **20,000,000 bytes** (checked on `File.size` before reading) or **20,000 findings** (counted
while parsing; early stop). SARIF and other formats rejected. Detection: first non-space byte `[` -> gitleaks; leading lines that
parse as objects with `DetectorName` -> trufflehog; mixed -> ambiguous (explicit format selector). Malformed records give an
import error with location and count, never report text.

## gitleaks (JSON array; `gitleaks detect --report-format json`)

| Field | Type | Used for | Notes |
|---|---|---|---|
| `RuleID` | string | `ruleId`, S-R4 | e.g. `github-pat`, `aws-access-token`, `generic-api-key`, `private-key` |
| `Description` | string | not used | |
| `StartLine` / `EndLine` | int | `line` | 1-based (assumed); `EndLine` > `StartLine` for multi-line (PEM) |
| `StartColumn` / `EndColumn` | int | not used | 1-based, inclusive end (assumed) |
| `Match` | string | match-line fallback | rule's whole match (keyword + value); masked as a line, not indexed as a value |
| `Secret` | string | `rawValue` | falls back to `Match` when absent |
| `File` / `SymlinkFile` | string | `path` | repository-relative |
| `Commit` | string | `commit` | empty in `--no-git` mode |
| `Entropy` | number | display only | never FP evidence |
| `Author`, `Email`, `Date`, `Message`, `Tags` | | not used | |
| `Fingerprint` | string | `fingerprint`, `.gitleaksignore` | no-git `file:rule:line`; git `commit:file:rule:line`; kept only if it passes the leak guard |
| `Line` | string | match line when present | may not be emitted in JSON (believed `json:"-"` in v8); parsers fall back to `Match` |

## trufflehog (JSON lines; `trufflehog filesystem --json` / `git --json`)

| Field | Type | Used for | Notes |
|---|---|---|---|
| `DetectorName` | string | `ruleId`, S-R4 | e.g. `Github`, `AWS`, `Slack`, `Stripe`, `Gitlab`, `NpmToken`, `PrivateKey` |
| `DetectorType` | int | `ruleId` fallback `detector-<n>` | not emitted by the synthetic generator |
| `Verified` | bool | `verified` | `true` -> verified (S-R1); `false`/missing -> unknown, never "not real"; "verification enabled" checkbox changes the label to `unverified` only |
| `Raw` | string | `rawValue` | |
| `RawV2` | string | extra guarded value | masked + guarded, never displayed |
| `SourceMetadata.Data.Filesystem.{file,line}` | string/int | `path`, `line` | line assumed 1-based |
| `SourceMetadata.Data.Git.{file,line,commit}` | | `path`, `line`, `commit` | |
| `DecoderName`, `Redacted`, `SourceID`, `SourceType`, `SourceName`, `ExtraData`, `StructuredData` | | not used | |

Trufflehog records carry no source line: without folder context the window is empty and views show the masked value only.
Trufflehog findings never enter `.gitleaksignore`.

## Synthetic fixtures

`src/core/synth/` emits both shapes (seeded, deterministic). Synthetic gitleaks records omit `Line`; trufflehog records use the
filesystem source and omit `DetectorType`. Tokens are random, never valid, assembled at run time. They validate the parsers
against this page, not against the real scanners (D1).
