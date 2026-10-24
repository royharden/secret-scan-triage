# Secret-scan triage

A local review workspace for gitleaks JSON arrays and trufflehog JSON-lines reports. Raw report contents are read in a worker;
the page receives guarded masked findings and a session-only hashed leak index. Human decisions and downloads are dry runs.

This repository currently contains **M1 through M4 source only**: normalisation/masking/signals/policy, a seeded synthetic generator,
a clearly labelled scripted mock judge, file/demo import, keep/review/collapsed suggested-dismissal bands, append-only local
approve/mark-real/skip rulings, binding-checked replay, a seeded dismissal audit, keyboard controls and guarded JSON/CSV/Markdown/ignore downloads. The worker is terminated after its result; the page rebuilds
its guard from numeric hash data to check state and exports. A blocked finding is omitted and counted for local review.

**Construction preview, never run.** Dependencies have not been installed; type checking, lint, tests, production builds,
browser UI, privacy network capture and memory behavior remain unverified. Static parsing covers erasable `.ts` syntax only;
`.tsx` has been inspected without a type checker. See [the deferred-validation ledger](docs/DEFERRED-VALIDATION.md).

Thresholds are `untuned-default`, judge-based dismissal is disabled, and all judge scores are **scripted mock** scores.
No accuracy, recall, latency, memory or cost result has been measured. No LLM or provider network path is active.

The keyless default needs browser Web Crypto, Web Workers and IndexedDB. A random client-only identity salt, append-only sanitized rulings and immutable audit cohorts are persisted
in IndexedDB. Keyed finding identities remain stable across imports. Raw reports and guard keys/indexes are never persisted. Clearing site data replaces the identity salt. Reloading requires re-import before notes, exports, cloud upload or inference.
The UI statement about local processing describes intended source behavior; runtime privacy verification is still D19.

Optional Setup handles missing public Supabase configuration by returning a null client. No client is constructed until Setup
is explicitly opened. `.env.example` contains only public browser fields; server/service-role/provider secrets do not belong
in `VITE_` variables. Live auth, inference, cloud storage and budget enforcement are later milestones, not current features.

Input limits are 20,000,000 bytes (checked before the worker reads a file) and 20,000 findings. SARIF is unsupported.
Guard snapshots also have a bounded transport capacity; an import that cannot retain the full guard fails closed.

After Dirty Mode closes and installation/runtime work is authorized, run `npm install` once to create and review the lockfile;
then run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Follow D21/D22 for the browser journey. No such
command has been executed during construction.

Optional folder context is read in the same worker pass, with a directory-input fallback for preview iframes. A run-2 demo tests changed context and equal-mask value replacement. Changing a decision appends an event; it does not overwrite history. Quota/transaction failures never claim a save.

The scorer source includes six comparators, paired group-bootstrap intervals, dev tuning, matched-recall sweeps, cache provenance and evaluation-only ablations. It has never run. `npm run eval -- --freeze` later freezes a generated manifest; `npm run eval` is scripted interface replay. Live source integration is the next milestone. They are not represented as built here. Nothing changes scanner reports, source files or credentials.

<!-- CLAIM:BEGIN -->
Not yet measured. Scripted-mock output is interface replay, not model performance. No real-world generalisation is established.
<!-- CLAIM:END -->
