import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
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
      ],
      // Baseline after SignalOutput refactoring (details vs signals).
      // Last measured: lines 64.91%, branches 54.43%, functions 69.94%.
      // Buffer of ~2pp below measured to absorb CI platform variance.
      thresholds: {
        lines: 62,
        functions: 67,
        branches: 52,
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
