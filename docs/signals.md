# Deterministic signals

Source of truth for the table: `config/signals.json` (validated at load against `CANONICAL_SIGNALS` in
`src/core/signals/index.ts`; any drift in id, name, direction, strength or the downgrade-only flag is rejected). This page mirrors
the plan (Claude §2.4) for readers. Thresholds in the config are **untuned defaults**, not measurements.

Every signal carries an evidence pointer (`CitedPointer`) **bound to the finding's own span** in the raw match line, computed
inside the parse worker (or the Node eval process). A pattern elsewhere on the same line does not fire a signal for this finding
(T17: a reference and a literal on one line). Entropy used by signals is computed in code from the value; scanner-reported
entropy is display only and never evidence.

| Id | Name | Direction / strength | Rule |
|---|---|---|---|
| S-R1 | `trufflehog_verified` | real / **decisive** | trufflehog `Verified: true`. Nothing overrides it (T13, T18). `Verified:false` or missing is *unknown*, never "not real" (T14). |
| S-R2 | `full_pem_body` | real / strong | Complete, matching PEM block with a non-elided body bound to the finding (T12 full). |
| S-R3 | `provider_format_exact` | real / strong | Fixed-prefix provider format whose whole value matches length bounds and charset. Single source: `config/prefixes.json` (the same specs the mask keeps prefixes from), matched with `matchProviderFormat` (`src/core/mask/mask.ts`). `config/signals.json` has no format list (a `provider_formats` key is rejected at load). |
| S-R4 | `high_precision_rule` | real / strong | Rule id (gitleaks rule or trufflehog detector, case-insensitive) listed in `config/high-precision-rules.json`. |
| S-R5 | `keyword_assignment_high_entropy` | real / strong | Credential keyword assignment (`password = ...`, `api_key: ...`) whose computed entropy is above the class threshold. |
| S-F1 | `documented_sentinel` | fp / **decisive** | Exact match on the fixed sentinel list (e.g. the AWS documentation example key pair; stored split into parts in config). T01. |
| S-F2 | `reference_not_literal` | fp / **decisive** | The finding's span is inside `os.environ[...]`, `os.getenv(...)`, `process.env.X`, `${VAR}`, `{{ var }}`, `%VAR%`. T04, T17 (reference half). |
| S-F3 | `lockfile_integrity` | fp / **decisive** | `integrity` hash in a lockfile path (`lockfile_basenames`). T02. |
| S-F4 | `pem_elided` | fp / **decisive** | Every finding occurrence belongs to a complete, matching PEM block with an empty, short or elided body (`...`, `(truncated)`, `<...>`). Incomplete/ambiguous blocks give no proof. T12 elided. |
| S-F5 | `placeholder_word` | fp / strong | `changeme`, `your_api_key`, `xxxx`, `<token>`, `example`, `dummy`, `redacted`, ... T05, T07. |
| S-F6 | `uuid_or_commit_shape` | fp / strong | UUID or 40-hex commit shape. T03. |
| S-F7 | `data_uri` | fp / strong | `data:...;base64,` blob. T11. |
| S-F8 | `self_named` | fp / strong | Value equals or derives from its own variable name. T16. |
| S-F9 | `low_entropy_for_class` | fp / weak | Computed entropy below the class threshold (length-adjusted). |
| S-F10 | `identifier_shape` | fp / weak | camel/snake identifier or dictionary-word tokens. |
| S-F11 | `path_test_fixture_docs` | fp / weak, **downgrade only** | Test, fixture or docs path class. May move `keep -> review`, never `review -> dismiss` (T06, T08). |

## Injection flag (not a signal)

`screen.injection` (`src/core/screen/prefilter.ts`, `screenInjection`) runs on the **raw** match line and window inside the worker.
It flags triager-directed directives ("ignore", "triager", "AI", "assistant", "mark as false positive", ...). A flagged,
non-verified finding goes to `review` with the flag shown (T10). A verified finding stays `keep` (T18). Comments such as
"rotated, ignore" (T09) are untrusted report text and are **never** false-positive evidence.

## How signals are used (summary of Claude §2.5)

Stage 1 (`resolveDeterministic`): decisive real -> `keep`; injection or malformed evidence -> `review`; decisive FP on the span
together with strong real on the span -> `review`, except the S-F1 exact sentinel -> suggested `dismiss`; decisive FP alone ->
suggested `dismiss`; otherwise `unresolved` (eligible for the judge). Stage 2 (`decideWithJudge`) applies thresholds from
`config/thresholds.json` in code; the judge alone never dismisses a high-precision rule, and judge dismissal is disabled while
`judge_dismiss_enabled` is `false` (the shipped untuned default). Every "dismiss" is a suggestion; only a human approval creates a
dismissal ruling.

## Status

Written in Dirty Mode construction. The signal tests exist under `tests/` but have **not been run** (see
`docs/DEFERRED-VALIDATION.md`, D3). Per-signal precision on real data is **not yet measured**.
