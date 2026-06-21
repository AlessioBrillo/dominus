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
      // Baseline after including previously-excluded db/ and api/ modules.
      // Last measured: lines 68%, branches 57.2%, functions 72.89%.
      // Buffer of ~2pp below measured to absorb CI platform variance.
      thresholds: {
        lines: 66,
        functions: 71,
        branches: 55,
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
