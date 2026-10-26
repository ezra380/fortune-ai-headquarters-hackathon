import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'supabase/functions/*/test/**/*.test.ts',
      'supabase/tests/**/*.test.ts',
    ],
    // The real-database tests share one local Postgres; run files one at a time.
    fileParallelism: false,
    environment: 'node',
    testTimeout: 20_000,
  },
});
