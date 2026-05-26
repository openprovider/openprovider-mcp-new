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
        'src/secrets/db-repo.ts',
        'src/server.ts',
        'src/openprovider/types.ts',
        'src/openprovider/errors.ts',
        'src/openprovider/token-cache-pg.ts',
        'src/audit/pg-sink.ts',
        'src/audit/object-store.ts',
        'src/policies/repo.ts',
        'src/tools/list-pending-confirmations.ts',
        'src/tools/confirm-pending.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
