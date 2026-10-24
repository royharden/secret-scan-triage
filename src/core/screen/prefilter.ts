// Code pre-filter for directive-like text aimed at the triager (traps T09, T10, T18). Always on, no model involved.
// A hit is a FLAG (Flags.injection), not a signal: it routes every non-verified finding to review and is never FP evidence.
// Runs in the worker on the raw match line and raw window lines (raw text is needed to see the directive; only the boolean
// leaves the worker). Matching is case-insensitive on word boundaries after removing zero-width/bidi control characters.

/** Single words / short phrases. Multi-word entries match across any run of whitespace, '_' or '-'. */
export const INJECTION_DIRECTIVES: ReadonlyArray<string> = Object.freeze([
  'ignore',
  'disregard',
  'triager',
  'triage bot',
  'AI',
  'assistant',
  'LLM',
  'chatbot',
  'mark as false positive',
  'false positive',
  'not a secret',
  'not a real secret',
  'not real',
  'safe to dismiss',
  'safe to ignore',
  'dismiss this',
  'do not flag',
  "don't flag",
  'do not report',
  'previous instructions',
  'system prompt',
  'you are an',
  'p_real',
  'reason_code',
]);

const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseSource(phrase: string): string {
  return phrase
    .trim()
    .split(/\s+/)
    .map((w) => escapeRe(w).replace(/'/g, "['’]?"))
    .join('[\\s_-]+');
}

/**
 * Word boundaries: a directive must not be glued to letters/digits on either side. '_' counts as a separator so that
 * `# AI_NOTE: ignore` and `ignore_this` still match, while `.gitignore` and `openai` do not.
 */
const DIRECTIVE_RE = new RegExp(
  `(?<![A-Za-z0-9])(?:${INJECTION_DIRECTIVES.map(phraseSource).join('|')})(?![A-Za-z0-9])`,
  'i',
);

export function containsDirective(text: string): boolean {
  return DIRECTIVE_RE.test(text.replace(INVISIBLE, ''));
}

/**
 * True when any of the given raw lines (match line plus window lines) contains a triager-directed directive.
 * Non-string entries are ignored.
 */
export function screenInjection(rawLineAndWindow: string[]): boolean {
  for (const line of rawLineAndWindow) {
    if (typeof line === 'string' && line.length > 0 && containsDirective(line)) return true;
  }
  return false;
}
