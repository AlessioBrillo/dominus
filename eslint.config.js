// @ts-check
import eslint from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    ignores: ['dist/', 'coverage/', '*.cjs', 'vitest.config.ts', 'vitest.setup.ts'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // ESM-only codebase: `require`/`__dirname`/`__filename` are not
      // available in `"type": "module"` modules. Fail lint on any use so
      // the defect never ships in a published artifact.
      '@typescript-eslint/no-require-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vitest',
              message:
                "vitest is a test-only dependency. Import it from a file under __tests__/ (e.g. '__tests__/<name>.ts' or '<name>.test.ts'), not from production modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.bench.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // CLI commands legitimately use console.log for stdout output
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Release and test scripts are CommonJS/ESM scripts that use Node
    // globals (console, process, __dirname, require) directly.
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Database migration validation is a standalone script
    files: ['src/db/validate-migration-sync.ts'],
    rules: { 'no-console': 'off' },
  },
];
