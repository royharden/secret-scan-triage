import { defineConfig } from 'vitest/config';

// Pure-core tests run in Node (Web Crypto is global in Node >= 20). UI tests added in later milestones may switch
// individual files to a DOM environment with a `// @vitest-environment` comment.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
