# Product agent instructions

Version 1 — 2026-10-24. Initial portable product instructions.

Read README.md, docs/privacy.md, docs/eval-method.md, docs/DEFERRED-VALIDATION.md and BOLT-HANDOFF.md before changing behavior. Current acceptance is source construction only. Dirty Mode forbids installs, tests, builds, application execution, network/provider calls, provisioning, pushing and deployment until the owner changes that instruction. Do not delete files. Local product commits only.

React routes live in src/app; browser import runs in src/worker. Canonical pure contracts/policy/providers/evaluation live in src/core. Browser integration lives in src/lib. Scripts are Node entrypoints; the Supabase function is self-contained. SQL migrations are forward-only source and have never run. No lockfile exists because installation was forbidden.

Preserve report-wide masking, fresh session guard gates and serializeSafe outbound checks. Never exempt digests or log raw exceptions. Raw reports/context stay worker-local; no raw values, guards or identity salts in cloud/inference. Keep project identity separate from ephemeral guard keys. Cloud/inference consent starts off; configuration must fail closed. Model URLs/prices/caps are trusted server settings, never report data. Reserve and claim every paid attempt, including retries/screens; unknown cost is not zero.

The src/core files are canonical. Update the fixed staging list in scripts/sync-function-contract.ts only with closed imports; staged function copies must remain byte-equal. Do not hand-diverge them. Preserve verified-first deterministic policy and cannot-tell review behavior. Scripted mock scores never establish model performance.

Freeze data/group splits and dev-tuned configuration before heldout evaluation; repeated heldout runs are exploratory. Do not invent results, prices, tuned coefficients or dataset counts. CredData content and generated/private artifacts remain ignored. Keep agent plans, transcripts, reviews and receipts outside this product repository. Record deferred checks honestly; static parsing is not type checking or testing.

After runtime work is explicitly authorized, generate/review the lockfile, run the documented checks and record actual receipts. Do not weaken guard/ledger/RLS invariants to get a check passing. No remote/publication is currently authorized.
