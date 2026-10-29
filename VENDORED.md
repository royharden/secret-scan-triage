# Vendored code

Nothing vendored. Product code is newly authored. Prior-art concepts are acknowledged without copying implementation from trufflehog (AGPL), sift (licence conflict), or unlicensed repositories. Package dependencies retain their own licences and require a lockfile/licence review at activation.

`supabase/functions/triage-judge/_shared/core/` contains staged copies of this project's own canonical `src/core/` files, not third-party code. The fixed-list sync script and unexecuted contract tests require byte equality and import closure.

CredData source content is never committed; its optional builder emits metadata-only manifests under the documented contract. No dataset is bundled. SecretBench is excluded.
