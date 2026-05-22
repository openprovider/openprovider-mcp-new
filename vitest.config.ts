import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        // Infrastructure files covered by integration tests, not unit tests:
        'src/db/**',
        'src/secrets/aws-kms.ts',
        'src/secrets/db-repo.ts',
        'src/server.ts',
        'src/openprovider/types.ts',
        'src/openprovider/errors.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
