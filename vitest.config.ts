import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    benchmark: {
      reporters: ['default'],
      outputJson: './bench-results.json',
    },
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
        'src/benchmarks/**',
      ],
      // Threshold: 70% lines / 65% functions / 60% branches per CONTRIBUTING.md.
      // Postgres-adapter.ts (requires real PG) and Redis-dependent providers
      // (redis-client.ts inline fallbacks, provider-health.ts ping) keep the
      // average below the aspirational 80%; they are covered by integration
      // and manual smoke tests instead.
      thresholds: {
        lines: 70,
        functions: 65,
        branches: 60,
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
