import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    singleFork: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/index.ts',
        'src/cli.ts',
        'src/config.ts',
        'src/logger.ts',
        'src/types/**',
        'src/utils/**',
        'src/jobs/index.ts',
        'src/cli/commands/**',
        'src/providers/*/index.ts',
        'src/db/index.ts',
      ],
      // Current: 64% lines / 65% functions / 55% branches.
      // Large untested route files (public-router.ts, onboarding.ts, listings.ts)
      // and API routes (runs.ts, metrics.ts, docs.ts) pull the average down.
      // Coverage improvement tracked via incremental per-module work.
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
