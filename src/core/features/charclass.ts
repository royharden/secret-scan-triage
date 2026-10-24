// Character-class and path-class classification (pure).
import type { CharClass, PathClass } from '../finding.ts';

const PEM_HEADER = /-----BEGIN [A-Z0-9 ]*-----/;

/**
 * Order matters: pem, digits, hex, alnum, base64url, base64, mixed.
 * base64url needs at least one '-' or '_'; base64 needs at least one '+', '/' or trailing '='.
 */
export function classifyChars(s: string): CharClass {
  if (typeof s !== 'string' || s.length === 0) return 'mixed';
  if (PEM_HEADER.test(s)) return 'pem';
  if (/^[0-9]+$/.test(s)) return 'digits';
  if (/^[0-9a-fA-F]+$/.test(s)) return 'hex';
  if (/^[A-Za-z0-9]+$/.test(s)) return 'alnum';
  if (/^[A-Za-z0-9_-]+=*$/.test(s) && /[_-]/.test(s)) return 'base64url';
  if (/^[A-Za-z0-9+/]+=*$/.test(s)) return 'base64';
  return 'mixed';
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'pubspec.lock',
  'podfile.lock',
  'packages.lock.json',
  'mix.lock',
  'uv.lock',
]);

const FIXTURE_DIR = /(^|\/)(fixtures?|__fixtures__|testdata|test-data|test_data|mocks?|__mocks__|stubs?|samples?)\//i;
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e|integration-tests?)\//i;
const TEST_FILE = /(^|\/)([^/]*[._-](test|spec|tests)\.[a-z0-9]+|test_[^/]+\.py|[^/]+_test\.(go|py|rb|exs?))$/i;
const DOCS_DIR = /(^|\/)(docs?|documentation|examples?|samples?-docs|wiki|man)\//i;
const DOCS_FILE = /(^|\/)(readme|changelog|contributing|license|security)([.][a-z0-9]+)?$|\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i;
const CONFIG_FILE =
  /(^|\/)(\.env([.][^/]*)?|\.npmrc|\.pypirc|\.netrc|\.dockercfg|dockerfile|docker-compose[^/]*)$|\.(ya?ml|json|jsonc|toml|ini|cfg|conf|config|properties|env|xml|plist|tf|tfvars|hcl)$/i;
const SOURCE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|scala|swift|m|mm|c|h|cc|cpp|hpp|cs|php|pl|pm|sh|bash|zsh|ps1|psm1|lua|r|dart|ex|exs|erl|clj|cljs|groovy|gradle|vue|svelte|sql|ipynb)$/i;

/** Classify a report path. Case-insensitive; separators normalised to '/'. */
export function classifyPath(p: string): PathClass {
  if (typeof p !== 'string' || p.length === 0) return 'other';
  const path = p.replace(/\\/g, '/');
  const base = (path.split('/').pop() ?? '').toLowerCase();
  if (LOCKFILES.has(base)) return 'lockfile';
  if (FIXTURE_DIR.test(path)) return 'fixture';
  if (TEST_DIR.test(path) || TEST_FILE.test(path)) return 'test';
  if (DOCS_DIR.test(path) || DOCS_FILE.test(path)) return 'docs';
  if (CONFIG_FILE.test(path)) return 'config';
  if (SOURCE_FILE.test(path)) return 'source';
  return 'other';
}
