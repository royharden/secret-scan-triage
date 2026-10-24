# Local CredData metadata manifest

Construction source only; never run. The checked-in manifest has `status: not-run`, null counts/timestamp/reconciliation and
no selections. It contains no CredData content or empirical counts. The builder prepares metadata references, not an
evaluated gold result. Its row name is **CredData candidates (direct adapter)**; scanner-conditioned candidates are not a
gitleaks rerun or an external-population claim.

The specification/local prior-art report identifies Samsung/CredData as Apache-2.0, while downloaded files keep their
original projects' licences. That licence/schema information has not been reverified against a checkout. Credential values
are reportedly obfuscated, which may change format cues. No file content or credential value is copied by this builder.
SecretBench is excluded.

## Input contract

The builder accepts an explicitly prepared **normalized metadata CSV**, not a claimed native CredData export. No upstream
column names have been verified. Each file must contain exactly these five case-sensitive headers, in any order:

| Header | Meaning |
|---|---|
| `candidate_id` | Nonempty globally unique metadata candidate identifier, at most 512 characters |
| `repository_id` | Stable repository grouping identifier, at most 512 characters |
| `file_path` | Literal POSIX repository-relative reference, at most 4096 characters; never opened |
| `line` | Positive one-based source-line reference, up to nine decimal digits |
| `label` | Exactly `T`, `F` or `X` |

Outer whitespace is trimmed. IDs/paths must be single-line and contain no control characters. Source references cannot be
absolute, use backslashes/drive prefixes, or contain empty, `.` or `..` path segments. Duplicate candidate IDs and duplicate
`(repository_id, file_path, line)` references are rejected across the selected metadata files, avoiding duplicated labelled
lines in the sampling population. At least two repository groups are needed.

CSV supports a BOM, LF/CRLF, quoted commas and doubled quotes. Unclosed/misplaced quotes, text after a closing quote, blank
data records, missing cells, unknown/duplicate/missing headers, invalid labels and extra content/value columns fail closed.
It does not print offending field names, values, paths or parser fragments. Input is bounded to 100,000,000 bytes per file.

Programmatic callers may pass a complete `ColumnMapping` to `parseMetadataCsv(text, mapping)`, mapping `candidateId`,
`repositoryId`, `filePath`, `line`, `label` to five distinct explicit header names. The input must still have exactly those
five mapped columns; it is not an automatic upstream-schema detector. Custom mappings are not a CLI format or a claim that
native CredData columns have been verified. Source hashes identify the actual bytes; retain the mapping locally for replay.

## Label-rule reconciliation and sampling

Before generation, the owner must reconcile T/F/X with CredData's written labelling rules and record that review locally.
Supply its SHA-256 receipt digest with the explicit reconciliation flag. The builder records the attestation/hash; it cannot
verify that the owner read those rules and does not read the receipt or dataset source files. No current approval is implied.
Primary labels are T real, F/X negative. The X-as-real sensitivity policy is T/X real, F negative and uses **the identical
candidates and splits**; it never re-samples based on labels.

Repositories are sorted, seed-shuffled and partitioned before candidate sampling. Dev contains
`clamp(floor(repositoryCount * devFraction), 1, repositoryCount - 1)` whole repositories; default fraction 0.5. All dev metadata
rows are retained. A separate seeded uniform reservoir selects up to 5,000 held-out metadata lines without replacement.
The cap may be reduced but never increased above 5,000. There are no label quotas, assumed 6% ratio or promised true count.
The observed sample ratio can differ from the held-out pool. Duplicate underlying values across different repositories
cannot be checked by a metadata-only builder and remain a disclosed limitation.

## Local command and containment

After Dirty Mode closes and local execution is authorized, use Linux or WSL (native Windows and CI are rejected):

```sh
CREDDATA_DIR=/local/CredData npx tsx scripts/build-creddata-gold.ts \
  --metadata normalized/labels.csv --seed 26024 --heldout-cap 5000 \
  --labels-reconciled --reconciliation-sha256 <64-lowercase-hex-receipt-digest>
```

Repeat `--metadata` for multiple CSVs; their order is significant and recorded through ordered hashes. No directory scan,
download, scanner, provider or network path exists. `CREDDATA_DIR` must be an existing local directory. Every selected CSV
must be a relative `.csv` beneath its canonical root; lexical traversal and realpath/symlink escapes are rejected before
reading. Only these explicit metadata files are read; **the `file_path` references are never opened**. The process refuses
known CI environment markers. Importing the module for unit tests performs no file I/O or CLI work.

The only output is `fixtures/creddata-manifest.json`; its directory must be the real project fixtures directory, an existing
output cannot be a symlink, and every prior manifest is backed up before replacement. No files are deleted. Error output
uses fixed structural messages and optional logical record numbers; engine messages and filesystem paths are never echoed.

## Output format

A completed metadata-only manifest has `status: metadata-sampled`, an actual generation timestamp, actual T/F/X counts for
population/dev/held-out pool/held-out selection, grouping counts, configuration and the reconciliation receipt digest.
`sources` stores source ordinal, metadata SHA-256 and row count. Each `selected` entry stores source ordinal, one-based logical
CSV data-row index, domain-separated SHA-256 candidate/repository identifiers, label, split and both label-policy booleans.
It stores **no source path, raw candidate/repository ID, credential value, source line or source content**. Hashes/reference
indices allow replay against the same local metadata bytes; they do not supply source code to an evaluator. The builder
has no credential-value index and makes no raw-value leak-guard or full-dataset evaluation claim.

Actual schema reconciliation, Linux filesystem behavior, tests and a dataset evaluation remain deferred. No numbers from
this manifest may be represented as model performance; an actual direct adapter and authorized evaluation remain later work.
