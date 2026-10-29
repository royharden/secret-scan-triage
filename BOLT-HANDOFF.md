# Bolt infrastructure handoff

2026-10-24 · M1–M6 source construction · runtime unverified.

## Current state and target

The product is a Vite/React/TypeScript app with a keyless worker-based local journey and optional Supabase auth, append-only cloud rulings, run summaries and capped live inference. All six planned source milestones are present; no partial-MVP cuts were used. Nothing has been installed, tested, built, deployed, provisioned or measured. No remote exists. There is no dependency lockfile yet. This document authorizes no infrastructure change.

A future fresh Bolt Database/Supabase-compatible backend is the intended target; no existing project, applied migration baseline, account, hosting URL or external database binding has been verified. Preserve an existing provider if the owner later supplies one. Resolve the target before applying SQL; do not assume a blank database. No Storage bucket, Realtime, cron, hosted worker, queue or payment resource is required. The parsing Web Worker is a browser asset.

## Source inventory and resource mapping

- `src/app`, `src/worker`, `src/lib`: local import/review/audit/exports, optional account/consent/live integration. `src/core`: canonical masking, policy, adapters, ledger and scorer.
- `supabase/migrations/20261101000100_rulings.sql`: append-only owner-scoped rulings, replay bindings and RLS.
- `20261101000200_triage_runs.sql`: owner-scoped sanitized summary counts/provenance. Unknown/incomplete cost is NULL.
- `20261101000300_judge_usage.sql`: judge_budgets/judge_usage, atomic service-only RPCs `open_judge_budget`, `reserve_judge_usage`, `claim_judge_dispatch`, `settle_judge_usage`; owner-read RLS, pinned security-definer search_path, duplicate binding and once-only dispatch.
- `supabase/functions/triage-judge`: JWT-gated function; auth.getUser precedes privileged clients/provider configuration. Fixed CORS origin list is not authorization. `handler.ts`, `reserve.ts`, `maskcheck.ts`, `index.ts` are function-specific. `_shared/core` is a closed set of first-party staged copies; `scripts/sync-function-contract.ts` and contract tests enforce equality.
- `scripts/eval.ts`, `scripts/live.ts`: scripted replay by default; explicit live mode shares a ledger across providers, retries and screens. Dev-only tuning and frozen heldout lineage; repetitions become exploratory. `scripts/build-creddata-gold.ts` is a separate optional local metadata builder, not a measured dataset adapter.

Auth source supports email/password sign-up/sign-in, logout, recovery email, explicit callback completion and password update. Configure Site URL, email confirmation and redirect allowlist for the eventual preview/hosted origins. Cloud storage and inference are separate session-only choices, initially off; switching account/store clears imported state. Local history is not bulk-uploaded. Reload requires fresh import for guarded actions. Local identity backup remains private and outside cloud/inference.

## Configuration names — no values supplied

Browser `.env.example`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_LIVE_JUDGE_ENABLED=false`. URL is HTTPS except loopback. These are public fields only. No service/provider key belongs in a VITE variable. Client creation is lazy on explicit Setup; no configured backend is required for the local design.

Platform server settings: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Live configuration additionally requires `JUDGE_LIVE_ENABLED=true`, positive `JUDGE_SESSION_USD`, `JUDGE_DAILY_USER_USD`, `JUDGE_DAILY_GLOBAL_USD`, and explicit comma-separated `JUDGE_ALLOWED_ORIGINS`. `JUDGE_SEMANTIC_SCREEN_ENABLED` is optional and off by default.

For each enabled provider use prefix `ANTHROPIC`, `OPENAI_COMPAT` or `TYPESAFE`, followed by `_API_KEY`, `_MODEL_ID`, `_INPUT_USD_PER_MILLION`, `_OUTPUT_USD_PER_MILLION`, `_PRICE_DATE`, `_PRICE_VERIFIED=true`. Verify current official contracts, availability and dated prices before filling values; no invented price/model is shipped. OpenAI-compatible additionally requires `_BASE_URL` (HTTPS ending /v1) and `_ALLOWED_ORIGINS` (explicit HTTPS origins). Report-controlled endpoints/models/caps are rejected.

TypeSafe source pins Jev `jev-1.13.0`, unverified against live docs here. Optional `TYPESAFE_CALIBRATION_JSON` must be trusted dev-fit configuration matching the parser; absent a fit, composition remains cannot_tell. Native Noul confidence is distinct from composed candidate probability. Jev is experimental, not promoted.

Node live evaluation also accepts `JUDGE_EVAL_USD` (otherwise config cap) and `JUDGE_EVAL_GENERATIVE_PROVIDER` (`anthropic` or `openai_compatible`). These settings do not authorize spend. Default transport bounds (15 seconds, 64 KiB response, 512 output tokens and conservative input reservation) need wire validation. No browser SDK receives server secrets.

## Acceptance and missing receipts

Independent source reviews accepted M1–M5, with M6 review recorded in the outer handoff when completed. Source parsing checks erasable TypeScript syntax only. No typecheck, lint, unit test, TSX compile, scanner run, dataset evaluation, SQL execution, RLS test, function deployment, provider request or browser observation has occurred. `docs/DEFERRED-VALIDATION.md` is the activation checklist, including D2 lockfile then D3 checks, D4/D12 SQL isolation/concurrency, D5 function, D9/D19 browser/picker/privacy and D16 official provider/price verification.

After owner authorization closes Dirty Mode: select target and capture its migration baseline; generate/review lockfile with npm install; run npm run typecheck, npm run lint, npm test and npm run build; run the keyless journey; then validate SQL on an isolated target with users A/B/anon and concurrent ledger attempts; deno-check and deploy only when authorized; validate auth redirects and explicit consent; enable one verified provider under approved caps and inspect request/log/storage captures. Record exact revisions, commands, outcomes and failures. Do not call source acceptance release acceptance.

## One inspect-and-prepare prompt for Bolt

> Inspect this repository and prepare a concrete infrastructure proposal only. Read AGENTS.md, README.md, docs/privacy.md, docs/DEFERRED-VALIDATION.md and this handoff. Identify the actual connected backend/hosting provider and existing migration baseline; preserve it and report uncertainty. Map the three SQL migrations, email auth redirects, JWT triage-judge function, closed first-party staged contracts, public browser variables and owner-managed server secrets/caps. Confirm that local keyless mode remains available and consents start off. List missing lockfile/checks, RLS/concurrency/auth/privacy/provider verification and owner actions with no invented results. Do not provision, migrate, deploy, publish, call paid providers or transfer dataset content. Return a reviewable proposal and leave execution for explicit owner authorization.
