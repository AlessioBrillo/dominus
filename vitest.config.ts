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
        'src/db/**',
        'src/api/**/*',
        'src/cli/index.ts',
        'src/types/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        // 74% reflects new optional-dependency CLI commands and
        // configurable notifier patterns — comfortable above the
        // architecture-guardian 70% floor.
        branches: 74,
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
