# Secret-scan triage

A local review workspace for gitleaks JSON arrays and trufflehog JSON-lines reports. Raw report contents are read in a worker;
the page receives guarded masked findings and a session-only hashed leak index. Human decisions and downloads are dry runs.

This repository currently contains **M1 + M2 source only**: normalisation/masking/signals/policy, a seeded synthetic generator,
a clearly labelled scripted mock judge, file/demo import, keep/review/collapsed suggested-dismissal bands, in-memory
approve/mark-real/skip decisions, and guarded masked JSON download. The worker is terminated after its result; the page rebuilds
its guard from numeric hash data to check state and exports. A blocked finding is omitted and counted for local review.

**Construction preview, never run.** Dependencies have not been installed; type checking, lint, tests, production builds,
browser UI, privacy network capture and memory behavior remain unverified. Static parsing covers erasable `.ts` syntax only;
`.tsx` has been inspected without a type checker. See [the deferred-validation ledger](docs/DEFERRED-VALIDATION.md).

Thresholds are `untuned-default`, judge-based dismissal is disabled, and all judge scores are **scripted mock** scores.
No accuracy, recall, latency, memory or cost result has been measured. No LLM or provider network path is active.

The keyless default needs browser Web Crypto, Web Workers and IndexedDB. Only a random client-only identity salt is persisted
in IndexedDB so keyed finding identities remain stable across imports. Raw reports, guard keys/indexes and decisions are never
persisted by this slice. Clearing site data replaces the identity salt. Reloading requires re-import before decisions or exports.
The UI statement about local processing describes intended source behavior; runtime privacy verification is still D19.

Optional Setup handles missing public Supabase configuration by returning a null client. No client is constructed until Setup
is explicitly opened. `.env.example` contains only public browser fields; server/service-role/provider secrets do not belong
in `VITE_` variables. Live auth, inference, cloud storage and budget enforcement are later milestones, not current features.

Input limits are 20,000,000 bytes (checked before the worker reads a file) and 20,000 findings. SARIF is unsupported.
Guard snapshots also have a bounded transport capacity; an import that cannot retain the full guard fails closed.

After Dirty Mode closes and installation/runtime work is authorized, run `npm install` once to create and review the lockfile;
then run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Follow D21/D22 for the browser journey. No such
command has been executed during construction.

Later milestones add persisted bound rulings/replay, audit sampling, folder context, more exports, an honest scorer, and live
provider/backend source. They are not represented as built here. Nothing changes scanner reports, source files or credentials.
