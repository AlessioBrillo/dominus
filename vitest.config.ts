import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
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
      // Measured: lines 72.71%, branches 61.86%, functions 75.63%.
      // Buffer of ~2pp below measured to absorb CI platform variance.
      thresholds: {
        lines: 70,
        functions: 73,
        branches: 59,
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
