import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
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
      // Measured: lines 80.52%, branches 71.98%, functions 85.08%.
      // Buffer of ~3pp below measured to absorb CI platform variance.
      thresholds: {
        lines: 77,
        functions: 82,
        branches: 68,
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
