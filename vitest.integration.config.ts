import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    // Container startup happens in beforeAll hooks; give them room under contention.
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Integration tests depend on per-suite testcontainers (Postgres + LocalStack).
    // A transient container-startup hiccup is not a code defect — retry once before failing.
    retry: 2,
  },
});
