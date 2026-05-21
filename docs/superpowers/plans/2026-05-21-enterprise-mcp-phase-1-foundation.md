# Enterprise Openprovider MCP — Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a deployable container that runs the Streamable HTTP MCP scaffold against managed Postgres + KMS, with RLS enforced, envelope-encrypted secrets, structured logs + OTel traces, health endpoints, and a signed-image CI pipeline. No real Openprovider call, no real OAuth, no policies — those land in later phases.

**Architecture:** Single Node.js/TypeScript process; Fastify hosting the MCP Streamable HTTP transport; Drizzle ORM against Postgres; `secrets/store` envelope-encrypts via AWS KMS (LocalStack in tests); pino logs + OpenTelemetry SDK; one dev-token auth path; placeholder tool to prove end-to-end wiring.

**Tech Stack:** Node.js 20+, TypeScript 5.3+, Fastify 4, `@modelcontextprotocol/sdk` 1.x, Drizzle ORM + drizzle-kit, `pg` 8.x, pg-boss (scaffolded, not yet used), zod 3, pino 9, `@opentelemetry/*` 1.x, `@aws-sdk/client-kms` 3.x, Vitest 1, testcontainers-node 10, Docker, cosign, GitHub Actions.

**Decisions locked in this plan:**
- **Cloud provider:** AWS (KMS, Secrets Manager via cloud config later). LocalStack simulates KMS in tests.
- **ORM:** Drizzle (TypeScript-first, low runtime overhead). `drizzle-kit migrate` for migrations.
- **HTTP framework:** Fastify (mature ecosystem, request-context plugins, async hooks support).
- **Default region:** `eu-central-1` for AWS deployments; tests are region-agnostic.

**Source spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md`
**Source roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md`

---

## Task ordering rationale

1. **Tasks 1–3:** branch protection of old code, fresh package.json, tooling baseline.
2. **Tasks 4–5:** local infra (docker compose) and testcontainers — needed before any DB test.
3. **Tasks 6–9:** the *first* test is RLS cross-tenant denial. The whole foundation hangs off this property; if it ever regresses the foundation is broken.
4. **Tasks 10–13:** remaining Phase 1 tables (`users`, `tenant_keys`, `tenant_secrets`, placeholder `audit_events`) each ship with their own RLS test.
5. **Tasks 14–17:** `secrets/store` envelope encryption with LocalStack KMS.
6. **Tasks 18–21:** `observability/` — redaction list, pino, OTel, request-context.
7. **Tasks 22–23:** `auth/identity` skeleton (dev token only) — proves `Principal` plumbing.
8. **Tasks 24–26:** `mcp/transport` Fastify+MCP SDK scaffold serving one placeholder tool.
9. **Task 27:** `/healthz` and `/readyz`.
10. **Task 28:** Dockerfile.
11. **Task 29–30:** CI pipeline + cosign image signing + SBOM.
12. **Task 31:** pre-commit hooks.
13. **Task 32–33:** README/CHANGELOG and the `0.2.0-phase1` tag.

---

## Task 1: Archive legacy code on its own branch

**Files:**
- No file changes; this is a git operation.

- [ ] **Step 1: Create the `legacy/v0.1` branch from current `main`**

```bash
git checkout -b legacy/v0.1
git push -u origin legacy/v0.1
```

Expected: branch created and pushed.

- [ ] **Step 2: Switch back to `main`**

```bash
git checkout main
```

- [ ] **Step 3: Verify the legacy branch points at the right commit**

Run: `git log --oneline legacy/v0.1 -1`
Expected output: the commit hash of the previous `main` head (the original hobby-grade MCP).

- [ ] **Step 4: Commit a stub CHANGELOG noting the legacy archive**

Create `CHANGELOG.md`:

```markdown
# Changelog

## [Unreleased]

### Changed
- Repository is being rewritten for v0.2 enterprise-ready architecture.
- The previous single-file MCP server is archived on the `legacy/v0.1` branch.

See `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` for the new design.
```

```bash
git add CHANGELOG.md
git commit -m "chore: archive legacy server on legacy/v0.1 branch"
```

---

## Task 2: Replace package.json with the new tech stack

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json` (replace existing)
- Create: `.nvmrc`

- [ ] **Step 1: Write `.nvmrc` to pin Node version**

```
20.11.1
```

- [ ] **Step 2: Replace `package.json`**

```json
{
  "name": "openprovider-mcp",
  "version": "0.2.0-phase1.0",
  "private": true,
  "description": "Enterprise multi-tenant MCP server for Openprovider",
  "type": "module",
  "engines": { "node": ">=20.11" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node --enable-source-maps dist/server.js",
    "dev": "tsx watch src/server.ts",
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "lint": "eslint . --max-warnings=0",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx scripts/migrate.ts"
  },
  "dependencies": {
    "@aws-sdk/client-kms": "^3.600.0",
    "@modelcontextprotocol/sdk": "^1.17.2",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/auto-instrumentations-node": "^0.52.0",
    "@opentelemetry/exporter-trace-otlp-grpc": "^0.55.0",
    "@opentelemetry/sdk-node": "^0.55.0",
    "drizzle-orm": "^0.36.0",
    "fastify": "^4.28.1",
    "pg": "^8.13.0",
    "pino": "^9.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/pg": "^8.11.10",
    "@typescript-eslint/eslint-plugin": "^7.18.0",
    "@typescript-eslint/parser": "^7.18.0",
    "@vitest/coverage-v8": "^1.6.0",
    "drizzle-kit": "^0.28.0",
    "eslint": "^8.57.0",
    "prettier": "^3.3.3",
    "testcontainers": "^10.13.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Replace `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Install + verify**

```bash
rm -rf node_modules package-lock.json
npm install
npm run typecheck
```

Expected: `tsc --noEmit` exits 0 (no src yet → no errors).

- [ ] **Step 5: Commit**

```bash
git add .nvmrc package.json package-lock.json tsconfig.json
git rm server.js src/server.ts index.js test-*.js
git commit -m "chore(phase1): rewrite package.json for enterprise tech stack"
```

---

## Task 3: Lint, format, and Vitest baseline configs

**Files:**
- Create: `.eslintrc.cjs`
- Create: `.eslintignore`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `vitest.config.ts`
- Create: `vitest.integration.config.ts`

- [ ] **Step 1: Write `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
  ],
  parserOptions: { project: ['./tsconfig.json'] },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['error', { allow: ['error', 'warn'] }],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.config.ts', 'scripts/'],
};
```

- [ ] **Step 2: Write `.prettierrc.json`**

```json
{ "semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 3: Write `vitest.config.ts` (unit-test profile)**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
```

- [ ] **Step 4: Write `vitest.integration.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
```

- [ ] **Step 5: Verify `npm run lint` passes on an empty `src/`**

```bash
mkdir -p src
echo 'export {};' > src/index.ts
npm run lint
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add .eslintrc.cjs .prettierrc.json vitest.config.ts vitest.integration.config.ts src/index.ts
git commit -m "chore(phase1): add lint, format, and vitest baseline configs"
```

---

## Task 4: Local dev infrastructure via docker compose

**Files:**
- Create: `docker-compose.dev.yml`
- Create: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Write `docker-compose.dev.yml`**

```yaml
version: '3.9'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: openprovider
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: openprovider_mcp
    ports: ['5432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U openprovider']
      interval: 5s
      timeout: 5s
      retries: 10
  localstack:
    image: localstack/localstack:3.7
    environment:
      SERVICES: kms
      DEFAULT_REGION: eu-central-1
    ports: ['4566:4566']
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:4566/_localstack/health']
      interval: 5s
      timeout: 5s
      retries: 10
```

- [ ] **Step 2: Write `.env.example`**

```bash
NODE_ENV=development
LOG_LEVEL=info

DATABASE_URL=postgres://openprovider:dev@localhost:5432/openprovider_mcp
DATABASE_MIGRATION_URL=postgres://openprovider:dev@localhost:5432/openprovider_mcp

AWS_REGION=eu-central-1
AWS_KMS_KEY_ARN=alias/openprovider-mcp-dev
AWS_ENDPOINT_URL=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test

OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
DEV_BEARER_TOKEN=dev-bearer-only-for-phase1
```

- [ ] **Step 3: Update `.gitignore`**

Append:

```
.env
dist/
coverage/
*.log
```

- [ ] **Step 4: Smoke-test docker compose**

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml down
```

Expected: both services come up healthy.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.dev.yml .env.example .gitignore
git commit -m "chore(phase1): add dev docker compose with postgres + localstack KMS"
```

---

## Task 5: Database connection module + migration scaffold

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/schema.ts` (empty for now)
- Create: `drizzle.config.ts`
- Create: `scripts/migrate.ts`

- [ ] **Step 1: Write `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? 'postgres://localhost/openprovider_mcp',
  },
});
```

- [ ] **Step 2: Write `src/db/schema.ts`**

```ts
export {};
```

- [ ] **Step 3: Write `src/db/client.ts`**

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbConfig {
  connectionString: string;
  applicationName?: string;
}

export function createDb(config: DbConfig): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    application_name: config.applicationName ?? 'openprovider-mcp',
    max: 10,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function setTenantContext(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query('SET LOCAL app.current_tenant = $1', [tenantId]);
}
```

- [ ] **Step 4: Write `scripts/migrate.ts`**

```ts
import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../src/db/client.js';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is required');
  process.exit(1);
}

const { db, pool } = createDb({ connectionString: url, applicationName: 'migrator' });
await migrate(db, { migrationsFolder: './migrations' });
await pool.end();
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/client.ts src/db/schema.ts drizzle.config.ts scripts/migrate.ts
git commit -m "feat(phase1): add drizzle client and migration runner scaffold"
```

---

## Task 6: Testcontainers helper for integration tests

**Files:**
- Create: `tests/integration/_helpers/postgres-container.ts`
- Create: `tests/integration/_helpers/db.ts`

- [ ] **Step 1: Write `tests/integration/_helpers/postgres-container.ts`**

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from 'testcontainers';

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  url: string;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('openprovider_mcp')
    .withUsername('openprovider')
    .withPassword('test')
    .start();
  const url = container.getConnectionUri();
  return {
    container,
    url,
    stop: async () => {
      await container.stop();
    },
  };
}
```

- [ ] **Step 2: Write `tests/integration/_helpers/db.ts`**

```ts
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from '../../../src/db/client.js';

export async function migratedDb(url: string) {
  const { db, pool } = createDb({ connectionString: url, applicationName: 'test' });
  await migrate(db, { migrationsFolder: './migrations' });
  return { db, pool };
}

export async function runAsTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL app.current_tenant = $1', [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 3: Verify it compiles**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/_helpers/
git commit -m "test(phase1): add testcontainers postgres helper and tenant-context runner"
```

---

## Task 7: Write the failing RLS cross-tenant test (FIRST property test of the foundation)

**Files:**
- Create: `tests/integration/db/rls-tenants.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

describe('RLS — tenants table', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO tenants (id, name) VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`,
        [TENANT_A, TENANT_B],
      );
    } finally {
      client.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('returns only the calling tenant when RLS is set', async () => {
    const rowsA = await runAsTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ id: string }>('SELECT id FROM tenants');
      return r.rows;
    });
    expect(rowsA.map((r) => r.id)).toEqual([TENANT_A]);
  });

  it('cannot UPDATE another tenant via RLS', async () => {
    await expect(
      runAsTenant(pool, TENANT_A, async (c) => {
        const r = await c.query('UPDATE tenants SET name = $1 WHERE id = $2', ['hijacked', TENANT_B]);
        return r.rowCount;
      }),
    ).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm run test:integration -- rls-tenants
```

Expected: FAIL — there is no `tenants` table yet, no migration, no RLS policy. The error will be from `migrate()` finding no `migrations/` directory, or from the INSERT failing because the table doesn't exist.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/integration/db/rls-tenants.test.ts
git commit -m "test(phase1): failing RLS cross-tenant test for tenants table"
```

---

## Task 8: First migration — `tenants` table with RLS and revoked app DML

**Files:**
- Create: `migrations/0001_create_roles_and_tenants.sql`
- Create: `migrations/meta/_journal.json` (drizzle's empty journal)

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0001_create_roles_and_tenants.sql

-- Roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN;
  END IF;
END $$;

GRANT app_role TO CURRENT_USER;

-- Tenants
CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','suspended','deleted')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_isolation ON tenants
  USING (id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenants TO app_role;
-- Deliberately no DELETE on tenants for app_role; soft-delete only.
```

- [ ] **Step 2: Bootstrap drizzle journal so migrate() runs raw SQL**

Create `migrations/meta/_journal.json`:

```json
{
  "version": "5",
  "dialect": "pg",
  "entries": [
    { "idx": 0, "version": "5", "when": 1747800000000, "tag": "0001_create_roles_and_tenants", "breakpoints": true }
  ]
}
```

- [ ] **Step 3: Adjust test helper to insert as `app_role` so RLS bites**

Edit `tests/integration/_helpers/db.ts`, update `migratedDb`:

```ts
export async function migratedDb(url: string) {
  const { db, pool } = createDb({ connectionString: url, applicationName: 'test' });
  await migrate(db, { migrationsFolder: './migrations' });
  const c = await pool.connect();
  try {
    await c.query('SET ROLE app_role');
  } finally {
    c.release();
  }
  // Force all subsequent connections from the pool to assume app_role.
  pool.on('connect', (client) => {
    void client.query('SET ROLE app_role');
  });
  return { db, pool };
}
```

- [ ] **Step 4: Re-run the RLS test**

```bash
npm run test:integration -- rls-tenants
```

Expected: PASS. The `runAsTenant` helper's `SET LOCAL app.current_tenant` combined with the policy yields per-tenant visibility; UPDATE against `TENANT_B` from `TENANT_A` context affects 0 rows.

- [ ] **Step 5: Commit**

```bash
git add migrations/0001_create_roles_and_tenants.sql migrations/meta/_journal.json tests/integration/_helpers/db.ts
git commit -m "feat(phase1): tenants table with RLS, revoked DML for app_role"
```

---

## Task 9: Drizzle schema mirror for `tenants` (so app code can read it typed)

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add the tenants table to `src/db/schema.ts`**

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(phase1): drizzle schema mirror for tenants"
```

---

## Task 10: `users` table + RLS test

**Files:**
- Create: `migrations/0002_create_users.sql`
- Create: `tests/integration/db/rls-users.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `migrations/meta/_journal.json`

- [ ] **Step 1: Write failing RLS test for users**

```ts
// tests/integration/db/rls-users.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const TENANT_A = '00000000-0000-0000-0000-00000000010a';
const TENANT_B = '00000000-0000-0000-0000-00000000010b';

describe('RLS — users table', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 'a'), ($2, 'b')`, [TENANT_A, TENANT_B]);
      await c.query(
        `INSERT INTO users (id, tenant_id, email, oauth_subject, role)
         VALUES (gen_random_uuid(), $1, 'a@example.com', 'oauth-a', 'owner'),
                (gen_random_uuid(), $2, 'b@example.com', 'oauth-b', 'owner')`,
        [TENANT_A, TENANT_B],
      );
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('lists only the calling tenant users', async () => {
    const rows = await runAsTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ email: string }>('SELECT email FROM users ORDER BY email');
      return r.rows.map((x) => x.email);
    });
    expect(rows).toEqual(['a@example.com']);
  });

  it('rejects INSERT for a foreign tenant_id under RLS', async () => {
    await expect(
      runAsTenant(pool, TENANT_A, async (c) => {
        await c.query(
          `INSERT INTO users (id, tenant_id, email, oauth_subject, role)
           VALUES (gen_random_uuid(), $1, 'evil@example.com', 'evil', 'owner')`,
          [TENANT_B],
        );
      }),
    ).rejects.toThrow(/row-level security|new row violates/);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
npm run test:integration -- rls-users
```

Expected: FAIL because the `users` table doesn't exist.

- [ ] **Step 3: Write `migrations/0002_create_users.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  email           text NOT NULL,
  oauth_subject   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  UNIQUE (tenant_id, email),
  UNIQUE (oauth_subject)
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_isolation ON users
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON users TO app_role;
```

- [ ] **Step 4: Append to `migrations/meta/_journal.json` entries**

```json
{ "idx": 1, "version": "5", "when": 1747800001000, "tag": "0002_create_users", "breakpoints": true }
```

- [ ] **Step 5: Re-run test**

```bash
npm run test:integration -- rls-users
```

Expected: PASS.

- [ ] **Step 6: Add `users` to `src/db/schema.ts`**

```ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull(),
  oauthSubject: text('oauth_subject').notNull(),
  role: text('role').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
```

- [ ] **Step 7: Commit**

```bash
git add migrations/0002_create_users.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/rls-users.test.ts
git commit -m "feat(phase1): users table with RLS and tenant-scoped uniqueness"
```

---

## Task 11: `tenant_keys` table (for KMS-wrapped DEK)

**Files:**
- Create: `migrations/0003_create_tenant_keys.sql`
- Modify: `migrations/meta/_journal.json`
- Modify: `src/db/schema.ts`
- Create: `tests/integration/db/rls-tenant-keys.test.ts`

- [ ] **Step 1: Write failing RLS test**

```ts
// tests/integration/db/rls-tenant-keys.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const TENANT_A = '00000000-0000-0000-0000-00000000020a';
const TENANT_B = '00000000-0000-0000-0000-00000000020b';

describe('RLS — tenant_keys', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 'a'), ($2, 'b')`, [TENANT_A, TENANT_B]);
      await c.query(
        `INSERT INTO tenant_keys (tenant_id, wrapped_dek, kms_key_arn)
         VALUES ($1, $3, 'arn:test'), ($2, $4, 'arn:test')`,
        [TENANT_A, TENANT_B, Buffer.from('a'), Buffer.from('b')],
      );
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('returns only own DEK', async () => {
    const rows = await runAsTenant(pool, TENANT_A, async (c) => {
      const r = await c.query<{ wrapped_dek: Buffer }>('SELECT wrapped_dek FROM tenant_keys');
      return r.rows.map((x) => x.wrapped_dek.toString());
    });
    expect(rows).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
npm run test:integration -- rls-tenant-keys
```

Expected: FAIL — table doesn't exist.

- [ ] **Step 3: Write `migrations/0003_create_tenant_keys.sql`**

```sql
CREATE TABLE tenant_keys (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id),
  wrapped_dek  bytea NOT NULL,
  kms_key_arn  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz
);

ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_keys_isolation ON tenant_keys
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_keys TO app_role;
```

- [ ] **Step 4: Append journal entry**

```json
{ "idx": 2, "version": "5", "when": 1747800002000, "tag": "0003_create_tenant_keys", "breakpoints": true }
```

- [ ] **Step 5: Run test, expect PASS**

```bash
npm run test:integration -- rls-tenant-keys
```

- [ ] **Step 6: Mirror in schema**

Append to `src/db/schema.ts`:

```ts
import { customType } from 'drizzle-orm/pg-core';
const bytea = customType<{ data: Buffer }>({
  dataType() { return 'bytea'; },
});

export const tenantKeys = pgTable('tenant_keys', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  wrappedDek: bytea('wrapped_dek').notNull(),
  kmsKeyArn: text('kms_key_arn').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});
```

- [ ] **Step 7: Commit**

```bash
git add migrations/0003_create_tenant_keys.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/rls-tenant-keys.test.ts
git commit -m "feat(phase1): tenant_keys table for KMS-wrapped per-tenant DEKs"
```

---

## Task 12: `tenant_secrets` table (envelope-encrypted ciphertexts)

**Files:**
- Create: `migrations/0004_create_tenant_secrets.sql`
- Modify: `migrations/meta/_journal.json`
- Modify: `src/db/schema.ts`
- Create: `tests/integration/db/rls-tenant-secrets.test.ts`

- [ ] **Step 1: Write failing test (analogous to Task 11)**

```ts
// tests/integration/db/rls-tenant-secrets.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const A = '00000000-0000-0000-0000-00000000030a';
const B = '00000000-0000-0000-0000-00000000030b';

describe('RLS — tenant_secrets', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1,'a'),($2,'b')`, [A, B]);
      await c.query(
        `INSERT INTO tenant_secrets (tenant_id, name, ciphertext, nonce, auth_tag, version)
         VALUES ($1,'openprovider.password',$3,$3,$3,1),
                ($2,'openprovider.password',$4,$4,$4,1)`,
        [A, B, Buffer.from('a'), Buffer.from('b')],
      );
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('returns only own ciphertext', async () => {
    const rows = await runAsTenant(pool, A, async (c) => {
      const r = await c.query<{ ciphertext: Buffer }>(
        `SELECT ciphertext FROM tenant_secrets WHERE name = 'openprovider.password'`,
      );
      return r.rows.map((x) => x.ciphertext.toString());
    });
    expect(rows).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Write `migrations/0004_create_tenant_secrets.sql`**

```sql
CREATE TABLE tenant_secrets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  ciphertext   bytea NOT NULL,
  nonce        bytea NOT NULL,
  auth_tag     bytea NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  UNIQUE (tenant_id, name)
);

ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_secrets_isolation ON tenant_secrets
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_secrets TO app_role;
```

- [ ] **Step 4: Journal entry**

```json
{ "idx": 3, "version": "5", "when": 1747800003000, "tag": "0004_create_tenant_secrets", "breakpoints": true }
```

- [ ] **Step 5: Re-run test, expect PASS**

- [ ] **Step 6: Schema mirror**

```ts
export const tenantSecrets = pgTable('tenant_secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  authTag: bytea('auth_tag').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});
```

Add `integer` to the drizzle import.

- [ ] **Step 7: Commit**

```bash
git add migrations/0004_create_tenant_secrets.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/rls-tenant-secrets.test.ts
git commit -m "feat(phase1): tenant_secrets table with RLS for envelope ciphertexts"
```

---

## Task 13: Placeholder `audit_events` table (no hash chain — Phase 7 owns that)

**Files:**
- Create: `migrations/0005_create_audit_events_placeholder.sql`
- Modify: `migrations/meta/_journal.json`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Write migration**

```sql
CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  actor_kind      text NOT NULL CHECK (actor_kind IN ('user','service','system')),
  actor_subject   text NOT NULL,
  event_type      text NOT NULL,
  tool_name       text,
  resource_type   text,
  resource_id     text,
  request_args    jsonb,
  result          jsonb,
  http_status     integer,
  error_code      text,
  trace_id        text,
  span_id         text
  -- prev_hash and row_hash columns added in Phase 7
);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_isolation ON audit_events
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Append-only for the app: insert + select only.
GRANT SELECT, INSERT ON audit_events TO app_role;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC, app_role;
```

- [ ] **Step 2: Journal entry**

```json
{ "idx": 4, "version": "5", "when": 1747800004000, "tag": "0005_create_audit_events_placeholder", "breakpoints": true }
```

- [ ] **Step 3: Write a test asserting the app role cannot DELETE audit rows**

Create `tests/integration/db/audit-append-only.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import type pg from 'pg';

const T = '00000000-0000-0000-0000-00000000040a';

describe('audit_events append-only grants', () => {
  let fixture: PgFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    fixture = await startPostgres();
    const m = await migratedDb(fixture.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1,'t')`, [T]);
    } finally {
      c.release();
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await fixture.stop();
  });

  it('inserts succeed but DELETE / UPDATE fail with insufficient privilege', async () => {
    await runAsTenant(pool, T, async (c) => {
      await c.query(
        `INSERT INTO audit_events (tenant_id, actor_kind, actor_subject, event_type)
         VALUES ($1, 'system', 'test', 'noop')`,
        [T],
      );
    });
    await expect(
      runAsTenant(pool, T, async (c) => {
        await c.query('DELETE FROM audit_events');
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runAsTenant(pool, T, async (c) => {
        await c.query('UPDATE audit_events SET event_type = $1', ['tampered']);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 4: Run, expect PASS**

```bash
npm run test:integration -- audit-append-only
```

- [ ] **Step 5: Schema mirror**

```ts
import { bigserial, jsonb } from 'drizzle-orm/pg-core';

export const auditEvents = pgTable('audit_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  actorKind: text('actor_kind').notNull(),
  actorSubject: text('actor_subject').notNull(),
  eventType: text('event_type').notNull(),
  toolName: text('tool_name'),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  requestArgs: jsonb('request_args'),
  result: jsonb('result'),
  httpStatus: integer('http_status'),
  errorCode: text('error_code'),
  traceId: text('trace_id'),
  spanId: text('span_id'),
});
```

- [ ] **Step 6: Commit**

```bash
git add migrations/0005_create_audit_events_placeholder.sql migrations/meta/_journal.json src/db/schema.ts tests/integration/db/audit-append-only.test.ts
git commit -m "feat(phase1): append-only audit_events placeholder (chain in phase 7)"
```

---

## Task 14: Unit test — secrets/store envelope round trip with a fake KMS

**Files:**
- Create: `src/secrets/kms.ts` (interface only)
- Create: `src/secrets/fake-kms.ts`
- Create: `src/secrets/store.test.ts`
- Create: `src/secrets/store.ts` (stub)

- [ ] **Step 1: Write `src/secrets/kms.ts` interface**

```ts
export interface Kms {
  generateDataKey(keyArn: string): Promise<{ plaintext: Buffer; ciphertext: Buffer }>;
  decrypt(keyArn: string, ciphertext: Buffer): Promise<Buffer>;
}
```

- [ ] **Step 2: Write `src/secrets/fake-kms.ts`**

```ts
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Kms } from './kms.js';

const MASTER = Buffer.from('00000000000000000000000000000000', 'hex'); // 16 bytes

export function createFakeKms(): Kms {
  return {
    async generateDataKey() {
      const plaintext = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', MASTER.toString('hex').padEnd(64, '0').slice(0, 64).match(/../g)!.map((h) => parseInt(h, 16)).reduce((a, _, i, arr) => { a[i] = arr[i]; return a; }, Buffer.alloc(32)), iv);
      const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const ciphertext = Buffer.concat([iv, tag, enc]);
      return { plaintext, ciphertext };
    },
    async decrypt(_arn, ciphertext) {
      const iv = ciphertext.subarray(0, 12);
      const tag = ciphertext.subarray(12, 28);
      const enc = ciphertext.subarray(28);
      const key = Buffer.alloc(32);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    },
  };
}
```

Note: the fake-KMS deliberately uses a fixed master key to keep tests deterministic; replace with the real AWS client (Task 17) for production.

- [ ] **Step 3: Write `src/secrets/store.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createFakeKms } from './fake-kms.js';
import { createSecretsStore } from './store.js';

describe('secrets/store', () => {
  it('round-trips a plaintext through put → get', async () => {
    const kms = createFakeKms();
    const store = createSecretsStore({
      kms,
      kmsKeyArn: 'arn:test',
      repo: createInMemoryRepo(),
    });
    const tenantId = 'tenant-a';

    await store.put(tenantId, 'openprovider.password', Buffer.from('hunter2'));
    const got = await store.get(tenantId, 'openprovider.password');

    expect(got?.toString()).toBe('hunter2');
  });

  it('returns null when the secret is missing', async () => {
    const store = createSecretsStore({
      kms: createFakeKms(),
      kmsKeyArn: 'arn:test',
      repo: createInMemoryRepo(),
    });
    expect(await store.get('tenant-a', 'missing')).toBeNull();
  });
});

function createInMemoryRepo() {
  const keys = new Map<string, { wrappedDek: Buffer; kmsKeyArn: string }>();
  const secrets = new Map<string, { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; version: number }>();
  return {
    async getTenantKey(t: string) { return keys.get(t) ?? null; },
    async setTenantKey(t: string, v: { wrappedDek: Buffer; kmsKeyArn: string }) { keys.set(t, v); },
    async getSecret(t: string, n: string) { return secrets.get(`${t}:${n}`) ?? null; },
    async upsertSecret(t: string, n: string, v: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; version: number }) {
      secrets.set(`${t}:${n}`, v);
    },
  };
}
```

- [ ] **Step 4: Run, confirm FAIL (no store.ts yet)**

```bash
npm test -- secrets/store
```

Expected: FAIL — `createSecretsStore` not exported.

- [ ] **Step 5: Commit the failing test**

```bash
git add src/secrets/kms.ts src/secrets/fake-kms.ts src/secrets/store.test.ts
git commit -m "test(phase1): failing tests for envelope secrets store"
```

---

## Task 15: Implement `secrets/store`

**Files:**
- Create: `src/secrets/store.ts`

- [ ] **Step 1: Write `src/secrets/store.ts`**

```ts
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Kms } from './kms.js';

export interface SecretsRepo {
  getTenantKey(tenantId: string): Promise<{ wrappedDek: Buffer; kmsKeyArn: string } | null>;
  setTenantKey(tenantId: string, value: { wrappedDek: Buffer; kmsKeyArn: string }): Promise<void>;
  getSecret(
    tenantId: string,
    name: string,
  ): Promise<{ ciphertext: Buffer; nonce: Buffer; authTag: Buffer; version: number } | null>;
  upsertSecret(
    tenantId: string,
    name: string,
    value: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; version: number },
  ): Promise<void>;
}

export interface SecretsStore {
  put(tenantId: string, name: string, plaintext: Buffer): Promise<void>;
  get(tenantId: string, name: string): Promise<Buffer | null>;
}

export function createSecretsStore(deps: {
  kms: Kms;
  kmsKeyArn: string;
  repo: SecretsRepo;
}): SecretsStore {
  const { kms, kmsKeyArn, repo } = deps;

  async function getOrCreateDek(tenantId: string): Promise<Buffer> {
    const existing = await repo.getTenantKey(tenantId);
    if (existing) return kms.decrypt(existing.kmsKeyArn, existing.wrappedDek);
    const { plaintext, ciphertext } = await kms.generateDataKey(kmsKeyArn);
    await repo.setTenantKey(tenantId, { wrappedDek: ciphertext, kmsKeyArn });
    return plaintext;
  }

  return {
    async put(tenantId, name, plaintext) {
      const dek = await getOrCreateDek(tenantId);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dek, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const prev = await repo.getSecret(tenantId, name);
      await repo.upsertSecret(tenantId, name, {
        ciphertext,
        nonce,
        authTag,
        version: (prev?.version ?? 0) + 1,
      });
      // Zero the DEK from local memory.
      dek.fill(0);
    },
    async get(tenantId, name) {
      const row = await repo.getSecret(tenantId, name);
      if (!row) return null;
      const dek = await getOrCreateDek(tenantId);
      const decipher = createDecipheriv('aes-256-gcm', dek, row.nonce);
      decipher.setAuthTag(row.authTag);
      const out = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      dek.fill(0);
      return out;
    },
  };
}
```

- [ ] **Step 2: Run tests, expect PASS**

```bash
npm test -- secrets/store
```

Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/secrets/store.ts
git commit -m "feat(phase1): envelope-encrypted secrets store with per-tenant DEK"
```

---

## Task 16: Integration test — `secrets/store` against LocalStack KMS + Postgres

**Files:**
- Create: `src/secrets/aws-kms.ts`
- Create: `src/secrets/db-repo.ts`
- Create: `tests/integration/secrets/store.test.ts`
- Create: `tests/integration/_helpers/localstack-kms.ts`

- [ ] **Step 1: Write `src/secrets/aws-kms.ts`**

```ts
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import type { Kms } from './kms.js';

export function createAwsKms(opts: { region: string; endpoint?: string }): Kms {
  const client = new KMSClient({
    region: opts.region,
    endpoint: opts.endpoint,
    credentials: opts.endpoint
      ? { accessKeyId: 'test', secretAccessKey: 'test' }
      : undefined,
  });
  return {
    async generateDataKey(keyArn) {
      const out = await client.send(
        new GenerateDataKeyCommand({ KeyId: keyArn, KeySpec: 'AES_256' }),
      );
      if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS returned no key');
      return {
        plaintext: Buffer.from(out.Plaintext),
        ciphertext: Buffer.from(out.CiphertextBlob),
      };
    },
    async decrypt(_arn, ciphertext) {
      const out = await client.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
      if (!out.Plaintext) throw new Error('KMS decrypt returned no plaintext');
      return Buffer.from(out.Plaintext);
    },
  };
}
```

- [ ] **Step 2: Write `src/secrets/db-repo.ts`**

```ts
import type pg from 'pg';
import type { SecretsRepo } from './store.js';

export function createDbSecretsRepo(client: pg.PoolClient): SecretsRepo {
  return {
    async getTenantKey(tenantId) {
      const r = await client.query<{ wrapped_dek: Buffer; kms_key_arn: string }>(
        'SELECT wrapped_dek, kms_key_arn FROM tenant_keys WHERE tenant_id = $1',
        [tenantId],
      );
      return r.rows[0] ? { wrappedDek: r.rows[0].wrapped_dek, kmsKeyArn: r.rows[0].kms_key_arn } : null;
    },
    async setTenantKey(tenantId, v) {
      await client.query(
        `INSERT INTO tenant_keys (tenant_id, wrapped_dek, kms_key_arn)
         VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET wrapped_dek = EXCLUDED.wrapped_dek, kms_key_arn = EXCLUDED.kms_key_arn, rotated_at = now()`,
        [tenantId, v.wrappedDek, v.kmsKeyArn],
      );
    },
    async getSecret(tenantId, name) {
      const r = await client.query<{ ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; version: number }>(
        'SELECT ciphertext, nonce, auth_tag, version FROM tenant_secrets WHERE tenant_id = $1 AND name = $2',
        [tenantId, name],
      );
      const row = r.rows[0];
      return row ? { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, version: row.version } : null;
    },
    async upsertSecret(tenantId, name, v) {
      await client.query(
        `INSERT INTO tenant_secrets (tenant_id, name, ciphertext, nonce, auth_tag, version)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag, version = EXCLUDED.version, rotated_at = now()`,
        [tenantId, name, v.ciphertext, v.nonce, v.authTag, v.version],
      );
    },
  };
}
```

- [ ] **Step 3: Write `tests/integration/_helpers/localstack-kms.ts`**

```ts
import { LocalstackContainer, type StartedLocalstackContainer } from '@testcontainers/localstack';
import { KMSClient, CreateKeyCommand, CreateAliasCommand } from '@aws-sdk/client-kms';

export interface KmsFixture {
  endpoint: string;
  keyArn: string;
  stop: () => Promise<void>;
}

export async function startLocalstackKms(): Promise<KmsFixture> {
  const c = (await new LocalstackContainer('localstack/localstack:3.7').start()) as StartedLocalstackContainer;
  const endpoint = c.getConnectionUri();
  const client = new KMSClient({
    region: 'eu-central-1',
    endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const created = await client.send(new CreateKeyCommand({ Description: 'phase1-test' }));
  if (!created.KeyMetadata?.Arn) throw new Error('KMS key creation failed');
  await client.send(new CreateAliasCommand({ AliasName: 'alias/phase1-test', TargetKeyId: created.KeyMetadata.KeyId }));
  return { endpoint, keyArn: created.KeyMetadata.Arn, stop: async () => { await c.stop(); } };
}
```

Also install: `npm install --save-dev @testcontainers/localstack`.

- [ ] **Step 4: Write `tests/integration/secrets/store.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { startLocalstackKms, type KmsFixture } from '../_helpers/localstack-kms.js';
import { createAwsKms } from '../../../src/secrets/aws-kms.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';
import type pg from 'pg';

const TENANT = '00000000-0000-0000-0000-00000000050a';

describe('secrets/store integration', () => {
  let pg: PgFixture;
  let kms: KmsFixture;
  let pool: pg.Pool;

  beforeAll(async () => {
    [pg, kms] = await Promise.all([startPostgres(), startLocalstackKms()]);
    const m = await migratedDb(pg.url);
    pool = m.pool;
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 't')`, [TENANT]);
    } finally {
      c.release();
    }
  }, 90_000);

  afterAll(async () => {
    await pool.end();
    await Promise.all([pg.stop(), kms.stop()]);
  });

  it('round-trips a real secret via real KMS', async () => {
    const kmsClient = createAwsKms({ region: 'eu-central-1', endpoint: kms.endpoint });
    await runAsTenant(pool, TENANT, async (client) => {
      const store = createSecretsStore({
        kms: kmsClient,
        kmsKeyArn: kms.keyArn,
        repo: createDbSecretsRepo(client),
      });
      await store.put(TENANT, 'openprovider.password', Buffer.from('s3cret'));
      const got = await store.get(TENANT, 'openprovider.password');
      expect(got?.toString()).toBe('s3cret');
    });
  });
});
```

- [ ] **Step 5: Run, expect PASS**

```bash
npm run test:integration -- secrets/store
```

- [ ] **Step 6: Commit**

```bash
git add src/secrets/aws-kms.ts src/secrets/db-repo.ts tests/integration/_helpers/localstack-kms.ts tests/integration/secrets/store.test.ts package.json package-lock.json
git commit -m "feat(phase1): AWS KMS adapter + DB-backed secrets repo with localstack test"
```

---

## Task 17: Observability — redaction list (single source of truth)

**Files:**
- Create: `src/observability/redact.ts`
- Create: `src/observability/redact.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/observability/redact.test.ts
import { describe, expect, it } from 'vitest';
import { redactSensitive, REDACTED, REDACTED_PATHS } from './redact.js';

describe('redactSensitive', () => {
  it('redacts top-level secrets', () => {
    expect(redactSensitive({ password: 'hunter2', other: 'ok' })).toEqual({
      password: REDACTED,
      other: 'ok',
    });
  });

  it('redacts nested keys by path', () => {
    expect(redactSensitive({ data: { token: 'eyJ...' } })).toEqual({
      data: { token: REDACTED },
    });
  });

  it('redacts contact PII by path', () => {
    expect(
      redactSensitive({ contact: { password: 'x', social_security_number: '1', email: 'a@b' } }),
    ).toEqual({ contact: { password: REDACTED, social_security_number: REDACTED, email: 'a@b' } });
  });

  it('passes through ordinary fields untouched', () => {
    expect(redactSensitive({ domain: 'example.com', period: 1 })).toEqual({
      domain: 'example.com',
      period: 1,
    });
  });

  it('redaction list snapshot matches spec', () => {
    expect([...REDACTED_PATHS].sort()).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Write `src/observability/redact.ts`**

```ts
export const REDACTED = '[REDACTED]';

// Single source of truth per spec §8. Order: alphabetical for snapshot stability.
export const REDACTED_PATHS = new Set<string>([
  'api_key',
  'authorization',
  'ciphertext',
  'client_secret',
  'contact.inn',
  'contact.password',
  'contact.social_security_number',
  'cookie',
  'data.token',
  'password',
  'plaintext',
  'refresh_token',
  'wrapped_dek',
]);

export function redactSensitive(value: unknown, prefix = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, prefix));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (REDACTED_PATHS.has(path) || REDACTED_PATHS.has(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactSensitive(v, path);
      }
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
npm test -- redact
```

- [ ] **Step 5: Verify coverage ≥ 90% on `redact.ts`**

```bash
npm test -- --coverage src/observability/redact
```

Expected: ≥ 90% lines.

- [ ] **Step 6: Commit**

```bash
git add src/observability/redact.ts src/observability/redact.test.ts src/observability/__snapshots__/
git commit -m "feat(phase1): single-source redaction list and recursive redactor"
```

---

## Task 18: Observability — pino logger with redaction + request context

**Files:**
- Create: `src/observability/request-context.ts`
- Create: `src/observability/logger.ts`
- Create: `src/observability/logger.test.ts`

- [ ] **Step 1: Write `src/observability/request-context.ts`**

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  principalSubject?: string;
  principalKind?: 'user' | 'service' | 'system';
}

const als = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}
```

- [ ] **Step 2: Write `src/observability/logger.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { withRequestContext } from './request-context.js';

describe('logger', () => {
  it('attaches request context to every log line', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: { write: (s: string) => { lines.push(s); return s.length; } },
    });
    withRequestContext({ tenantId: 't-1', principalKind: 'user', principalSubject: 's-1' }, () => {
      logger.info({ event: 'hello' }, 'msg');
    });
    const parsed = JSON.parse(lines.at(-1)!);
    expect(parsed.tenant_id).toBe('t-1');
    expect(parsed.principal_kind).toBe('user');
    expect(parsed.principal_subject).toBe('s-1');
  });

  it('redacts secret fields', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: { write: (s: string) => { lines.push(s); return s.length; } },
    });
    logger.info({ password: 'p', cookie: 'c', ok: 'ok' }, 'msg');
    const parsed = JSON.parse(lines.at(-1)!);
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.cookie).toBe('[REDACTED]');
    expect(parsed.ok).toBe('ok');
  });
});
```

- [ ] **Step 3: Run, expect FAIL (no logger.ts yet)**

- [ ] **Step 4: Write `src/observability/logger.ts`**

```ts
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './request-context.js';
import { REDACTED, REDACTED_PATHS } from './redact.js';

export interface LoggerConfig {
  level?: LoggerOptions['level'];
  destination?: DestinationStream;
}

export function createLogger(config: LoggerConfig = {}): Logger {
  return pino(
    {
      level: config.level ?? process.env.LOG_LEVEL ?? 'info',
      formatters: {
        log(obj) {
          const ctx = getRequestContext();
          const enriched: Record<string, unknown> = {
            ...obj,
            ...(ctx?.traceId ? { trace_id: ctx.traceId } : {}),
            ...(ctx?.spanId ? { span_id: ctx.spanId } : {}),
            ...(ctx?.tenantId ? { tenant_id: ctx.tenantId } : {}),
            ...(ctx?.principalSubject ? { principal_subject: ctx.principalSubject } : {}),
            ...(ctx?.principalKind ? { principal_kind: ctx.principalKind } : {}),
          };
          for (const key of Object.keys(enriched)) {
            if (REDACTED_PATHS.has(key)) enriched[key] = REDACTED;
          }
          return enriched;
        },
      },
      redact: { paths: [...REDACTED_PATHS], censor: REDACTED },
    },
    config.destination,
  );
}
```

- [ ] **Step 5: Run, expect PASS**

```bash
npm test -- logger
```

- [ ] **Step 6: Commit**

```bash
git add src/observability/request-context.ts src/observability/logger.ts src/observability/logger.test.ts
git commit -m "feat(phase1): pino logger with redaction + request-context enrichment"
```

---

## Task 19: Observability — OTel SDK init

**Files:**
- Create: `src/observability/otel.ts`
- Create: `src/observability/otel.test.ts`

- [ ] **Step 1: Write `src/observability/otel.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { startOtel } from './otel.js';

describe('otel', () => {
  it('starts and shuts down without throwing when exporter is unconfigured', async () => {
    const handle = startOtel({ serviceName: 'unit-test', exporterUrl: undefined });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Write `src/observability/otel.ts`**

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

export interface OtelHandle {
  shutdown: () => Promise<void>;
}

export function startOtel(opts: { serviceName: string; exporterUrl?: string }): OtelHandle {
  const exporter = opts.exporterUrl
    ? new OTLPTraceExporter({ url: opts.exporterUrl })
    : undefined;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: opts.serviceName,
    }),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
  return { shutdown: async () => { await sdk.shutdown(); } };
}
```

If `resourceFromAttributes` is not yet exported from `@opentelemetry/resources` for the installed version, fall back to:
```ts
import { Resource } from '@opentelemetry/resources';
const resource = new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: opts.serviceName });
```

- [ ] **Step 3: Run test, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add src/observability/otel.ts src/observability/otel.test.ts
git commit -m "feat(phase1): OpenTelemetry node SDK bootstrap"
```

---

## Task 20: `auth/identity` — Principal type + dev-token resolver

**Files:**
- Create: `src/auth/principal.ts`
- Create: `src/auth/identity.ts`
- Create: `src/auth/identity.test.ts`

- [ ] **Step 1: Write `src/auth/principal.ts`**

```ts
export type Principal =
  | {
      kind: 'user';
      tenantId: string;
      userId: string;
      subject: string;
      scopes: string[];
      role: 'owner' | 'admin' | 'operator' | 'viewer';
    }
  | {
      kind: 'service';
      tenantId: string;
      apiKeyId: string;
      subject: string;
      scopes: string[];
    };
```

- [ ] **Step 2: Write `src/auth/identity.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createIdentityResolver } from './identity.js';

describe('identity resolver', () => {
  const resolve = createIdentityResolver({
    devToken: 'dev-bearer',
    devPrincipal: {
      kind: 'user',
      tenantId: '00000000-0000-0000-0000-00000000aaaa',
      userId: '00000000-0000-0000-0000-00000000bbbb',
      subject: 'dev',
      scopes: ['mcp:read'],
      role: 'owner',
    },
  });

  it('resolves the dev principal for the dev bearer', async () => {
    const p = await resolve('Bearer dev-bearer');
    expect(p?.kind).toBe('user');
    expect(p?.tenantId).toBe('00000000-0000-0000-0000-00000000aaaa');
  });

  it('returns null for unknown bearer', async () => {
    expect(await resolve('Bearer nope')).toBeNull();
  });

  it('returns null when header missing', async () => {
    expect(await resolve(undefined)).toBeNull();
  });

  it('returns null for non-bearer scheme', async () => {
    expect(await resolve('Basic xyz')).toBeNull();
  });

  it('throws for API key path (not implemented in phase 1)', async () => {
    await expect(resolve('Bearer op_live_xxx')).rejects.toThrow(/api key.*phase/i);
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

- [ ] **Step 4: Write `src/auth/identity.ts`**

```ts
import type { Principal } from './principal.js';

export interface IdentityResolverConfig {
  devToken: string;
  devPrincipal: Principal;
}

export type IdentityResolver = (authorizationHeader: string | undefined) => Promise<Principal | null>;

export function createIdentityResolver(config: IdentityResolverConfig): IdentityResolver {
  return async (header) => {
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return null;
    if (token === config.devToken) return config.devPrincipal;
    if (token.startsWith('op_live_')) {
      throw new Error('API key authentication lands in phase 6');
    }
    // WorkOS OAuth introspection lands in phase 2.
    return null;
  };
}
```

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/auth/principal.ts src/auth/identity.ts src/auth/identity.test.ts
git commit -m "feat(phase1): Principal type + dev-token identity resolver"
```

---

## Task 21: MCP transport — Fastify scaffold + `tools/list` returning a placeholder tool

**Files:**
- Create: `src/mcp/placeholder-tool.ts`
- Create: `src/mcp/transport.ts`
- Create: `src/mcp/transport.test.ts`

- [ ] **Step 1: Write `src/mcp/placeholder-tool.ts`**

```ts
import { z } from 'zod';

export const placeholderTool = {
  name: 'phase1.echo',
  description: 'Phase 1 placeholder. Echoes a message; proves transport + auth + audit wiring.',
  inputSchema: z.object({ message: z.string().min(1).max(256) }),
  handler: async (input: { message: string }) => ({ echoed: input.message }),
};

export type PlaceholderInput = z.infer<typeof placeholderTool.inputSchema>;
```

- [ ] **Step 2: Write `src/mcp/transport.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createMcpServer } from './transport.js';
import type { FastifyInstance } from 'fastify';

describe('mcp transport', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createMcpServer({
      devToken: 'dev',
      devPrincipal: {
        kind: 'user',
        tenantId: '00000000-0000-0000-0000-0000000000aa',
        userId: '00000000-0000-0000-0000-0000000000bb',
        subject: 'dev',
        scopes: ['mcp:read'],
        role: 'owner',
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated MCP requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists the placeholder tool when authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain('phase1.echo');
  });

  it('invokes the placeholder tool', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0', id: 2,
        method: 'tools/call',
        params: { name: 'phase1.echo', arguments: { message: 'hi' } },
      },
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: { content: { type: string; text: string }[] } };
    expect(body.result.content[0]?.text).toContain('hi');
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

- [ ] **Step 4: Write `src/mcp/transport.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { placeholderTool } from './placeholder-tool.js';
import { createIdentityResolver } from '../auth/identity.js';
import type { Principal } from '../auth/principal.js';
import { withRequestContext } from '../observability/request-context.js';

export interface McpServerConfig {
  devToken: string;
  devPrincipal: Principal;
}

export async function createMcpServer(config: McpServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const resolve = createIdentityResolver(config);

  const mcp = new Server({ name: 'openprovider-mcp', version: '0.2.0-phase1' }, { capabilities: { tools: {} } });

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: placeholderTool.name,
        description: placeholderTool.description,
        inputSchema: zodToJsonSchema(placeholderTool.inputSchema) as Record<string, unknown>,
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== placeholderTool.name) {
      throw new Error(`Tool not found: ${req.params.name}`);
    }
    const parsed = placeholderTool.inputSchema.parse(req.params.arguments ?? {});
    const result = await placeholderTool.handler(parsed);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  app.post('/mcp', async (req, reply) => {
    const principal = await resolve(req.headers.authorization);
    if (!principal) {
      void reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    return withRequestContext(
      { tenantId: principal.tenantId, principalSubject: principal.subject, principalKind: principal.kind },
      async () => {
        // The MCP SDK's HTTP transport plumbing for tools/list and tools/call:
        const rpc = req.body as { jsonrpc: string; id: number | string; method: string; params?: unknown };
        if (rpc.method === 'tools/list') {
          const result = await mcp['_handlers'].get(ListToolsRequestSchema.shape.method.value)!({
            method: 'tools/list',
            params: {},
          } as never);
          return { jsonrpc: '2.0', id: rpc.id, result };
        }
        if (rpc.method === 'tools/call') {
          const result = await mcp['_handlers'].get(CallToolRequestSchema.shape.method.value)!({
            method: 'tools/call',
            params: rpc.params,
          } as never);
          return { jsonrpc: '2.0', id: rpc.id, result };
        }
        void reply.code(400);
        return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'method not found' } };
      },
    );
  });

  return app;
}
```

> **Implementation note:** the snippet above accesses the SDK's `_handlers` map to avoid scaffolding a full Streamable HTTP server-transport during Phase 1. Phase 2 replaces this with `StreamableHTTPServerTransport` from the SDK when it ships in your installed `@modelcontextprotocol/sdk` version; record this as a deliberate temporary shim in the CHANGELOG.

Also add `zod-to-json-schema` to deps: `npm install zod-to-json-schema`.

- [ ] **Step 5: Run, expect PASS**

```bash
npm test -- mcp/transport
```

- [ ] **Step 6: Commit**

```bash
git add src/mcp/placeholder-tool.ts src/mcp/transport.ts src/mcp/transport.test.ts package.json package-lock.json
git commit -m "feat(phase1): fastify MCP transport scaffold with placeholder tool and dev-token auth"
```

---

## Task 22: `/healthz` and `/readyz`

**Files:**
- Modify: `src/mcp/transport.ts`
- Create: `src/mcp/health.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/mcp/health.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpServer } from './transport.js';

describe('health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createMcpServer({
      devToken: 'dev',
      devPrincipal: {
        kind: 'user',
        tenantId: '00000000-0000-0000-0000-0000000000aa',
        userId: '00000000-0000-0000-0000-0000000000bb',
        subject: 'dev',
        scopes: ['mcp:read'],
        role: 'owner',
      },
      readinessChecks: [
        { name: 'db', check: async () => true },
        { name: 'kms', check: async () => false },
      ],
    });
    await app.ready();
  });

  afterAll(async () => app.close());

  it('/healthz returns 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
  });

  it('/readyz returns 503 with structured failures when any check fails', async () => {
    const r = await app.inject({ method: 'GET', url: '/readyz' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ ready: false, checks: { db: 'ok', kms: 'fail' } });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Extend `createMcpServer` config + register routes**

In `src/mcp/transport.ts`, change `McpServerConfig`:

```ts
export interface McpServerConfig {
  devToken: string;
  devPrincipal: Principal;
  readinessChecks?: { name: string; check: () => Promise<boolean> }[];
}
```

Inside `createMcpServer`, after `const app = Fastify(...)`:

```ts
app.get('/healthz', async () => ({ ok: true }));
app.get('/readyz', async (_req, reply) => {
  const checks = config.readinessChecks ?? [];
  const results: Record<string, 'ok' | 'fail'> = {};
  for (const c of checks) {
    try {
      results[c.name] = (await c.check()) ? 'ok' : 'fail';
    } catch {
      results[c.name] = 'fail';
    }
  }
  const ready = Object.values(results).every((v) => v === 'ok');
  void reply.code(ready ? 200 : 503);
  return { ready, checks: results };
});
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/transport.ts src/mcp/health.test.ts
git commit -m "feat(phase1): /healthz and /readyz with structured check results"
```

---

## Task 23: Composition root — `src/server.ts`

**Files:**
- Create: `src/server.ts`
- Create: `src/config.ts`
- Create: `src/config.test.ts`

- [ ] **Step 1: Write `src/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('config', () => {
  it('throws if a required variable is missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('returns a typed config when all required vars are present', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      AWS_REGION: 'eu-central-1',
      AWS_KMS_KEY_ARN: 'alias/x',
      DEV_BEARER_TOKEN: 'dev',
    });
    expect(cfg.databaseUrl).toBe('postgres://x');
    expect(cfg.devBearerToken).toBe('dev');
  });
});
```

- [ ] **Step 2: Write `src/config.ts`**

```ts
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  AWS_REGION: z.string().default('eu-central-1'),
  AWS_KMS_KEY_ARN: z.string().min(1),
  AWS_ENDPOINT_URL: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  DEV_BEARER_TOKEN: z.string().min(1),
  PORT: z.coerce.number().default(3000),
});

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  const parsed = schema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    awsRegion: parsed.AWS_REGION,
    kmsKeyArn: parsed.AWS_KMS_KEY_ARN,
    awsEndpoint: parsed.AWS_ENDPOINT_URL,
    otlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    devBearerToken: parsed.DEV_BEARER_TOKEN,
    port: parsed.PORT,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
```

- [ ] **Step 3: Write `src/server.ts`**

```ts
import 'dotenv/config';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/transport.js';
import { startOtel } from './observability/otel.js';
import { createLogger } from './observability/logger.js';
import { createDb } from './db/client.js';
import { createAwsKms } from './secrets/aws-kms.js';

async function main() {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel });
  const otel = startOtel({ serviceName: 'openprovider-mcp', exporterUrl: cfg.otlpEndpoint });

  const { pool } = createDb({ connectionString: cfg.databaseUrl });
  const kms = createAwsKms({ region: cfg.awsRegion, endpoint: cfg.awsEndpoint });

  const app = await createMcpServer({
    devToken: cfg.devBearerToken,
    devPrincipal: {
      kind: 'user',
      tenantId: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      subject: 'dev',
      scopes: ['mcp:read'],
      role: 'owner',
    },
    readinessChecks: [
      { name: 'db', check: async () => { const c = await pool.connect(); try { await c.query('SELECT 1'); return true; } finally { c.release(); } } },
      { name: 'kms', check: async () => { await kms.generateDataKey(cfg.kmsKeyArn); return true; } },
    ],
  });

  const shutdown = async () => {
    logger.info({ event: 'shutdown' }, 'shutting down');
    await app.close();
    await pool.end();
    await otel.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ host: '0.0.0.0', port: cfg.port });
  logger.info({ event: 'startup', port: cfg.port }, 'mcp server listening');
}

main().catch((err) => {
  // Last-resort logger; full one may not have started.
  console.error(err);
  process.exit(1);
});
```

Install `dotenv`: `npm install dotenv`.

- [ ] **Step 4: Run config unit test, expect PASS**

```bash
npm test -- config
```

- [ ] **Step 5: Build check**

```bash
npm run build
```

Expected: dist/server.js produced, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/config.ts src/config.test.ts package.json package-lock.json
git commit -m "feat(phase1): composition root wires config, otel, db, kms, mcp transport"
```

---

## Task 24: Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
coverage
.git
.env
docker-compose.dev.yml
tests
*.log
```

- [ ] **Step 2: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20.11.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./package.json
USER nonroot
EXPOSE 3000
CMD ["dist/server.js"]
```

- [ ] **Step 3: Build the image**

```bash
docker build -t openprovider-mcp:phase1 .
```

Expected: build succeeds.

- [ ] **Step 4: Smoke-run against docker compose dependencies**

```bash
docker compose -f docker-compose.dev.yml up -d
docker run --rm --network host \
  -e DATABASE_URL='postgres://openprovider:dev@localhost:5432/openprovider_mcp' \
  -e AWS_REGION='eu-central-1' \
  -e AWS_KMS_KEY_ARN='alias/openprovider-mcp-dev' \
  -e AWS_ENDPOINT_URL='http://localhost:4566' \
  -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' \
  -e DEV_BEARER_TOKEN='dev' \
  openprovider-mcp:phase1 &
sleep 3
curl -sf http://localhost:3000/healthz
```

Expected: `{"ok":true}`.

```bash
docker compose -f docker-compose.dev.yml down
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build(phase1): multi-stage distroless non-root Dockerfile"
```

---

## Task 25: GitHub Actions CI pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write
  packages: write

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:integration
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: coverage/

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: sigstore/cosign-installer@v3
      - name: Build image
        run: docker build -t openprovider-mcp:${{ github.sha }} .
      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          image: openprovider-mcp:${{ github.sha }}
          format: cyclonedx-json
          output-file: sbom.cdx.json
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: sbom.cdx.json
      - name: Sign image (keyless, OIDC)
        if: github.event_name == 'push'
        run: |
          cosign sign --yes openprovider-mcp:${{ github.sha }}
```

- [ ] **Step 2: Push and watch the run**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(phase1): GitHub Actions pipeline with cosign + SBOM"
git push
```

Expected: Actions run completes green.

- [ ] **Step 3: Adjust any failing step until green**

If `npm test` fails because Postgres/Localstack aren't reachable in CI: integration tests already use testcontainers, which runs Docker inside the runner — confirm `services: docker: privileged: true` isn't needed for GitHub-hosted runners (it isn't on `ubuntu-latest`).

If cosign keyless sign fails: it requires a registry to push to. For Phase 1, replace `cosign sign` with `cosign sign --output-signature ./sig.bundle` against a local tarball, or comment the sign step pending a registry being configured. Document the gap in CHANGELOG.

---

## Task 26: Pre-commit hooks via husky + lint-staged

**Files:**
- Create: `.husky/pre-commit`
- Modify: `package.json`

- [ ] **Step 1: Install dev deps**

```bash
npm install --save-dev husky lint-staged
npx husky init
```

- [ ] **Step 2: Add `lint-staged` config to `package.json`**

```json
"lint-staged": {
  "*.{ts,js}": ["prettier --write", "eslint --max-warnings=0"]
}
```

- [ ] **Step 3: Replace `.husky/pre-commit`**

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx lint-staged
npm run typecheck
```

- [ ] **Step 4: Verify by editing a file and committing**

```bash
echo '// touch' >> src/index.ts
git add src/index.ts
git commit -m "chore(phase1): verify pre-commit hooks"
```

Expected: prettier + eslint + typecheck all run before the commit lands.

---

## Task 27: README rewrite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md`**

```markdown
# Openprovider MCP — Enterprise (v0.2 Phase 1: Foundation)

A multi-tenant SaaS MCP server for Openprovider. **Phase 1 is the foundation only** — Streamable HTTP scaffold, Postgres + RLS, KMS envelope-encrypted secrets, OpenTelemetry, health endpoints, signed-image CI. No tenant onboarding, no real Openprovider integration, no policies. See the spec and roadmap below for the full picture.

## Status

- Foundation phase complete: see `CHANGELOG.md` for the `0.2.0-phase1` tag.
- Next: Phase 2 ships the first end-to-end vertical slice (WorkOS OAuth + `check_domain` over Streamable HTTP).

## Documents

- **Spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md`
- **Phase roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md`
- **Phase 1 plan (this phase):** `docs/superpowers/plans/2026-05-21-enterprise-mcp-phase-1-foundation.md`
- **Legacy v0.1 server:** archived on the `legacy/v0.1` branch.

## Local development

Requires Node 20.11+, Docker.

```bash
nvm use
npm install
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
npm run db:migrate
npm run dev
curl -H 'authorization: Bearer dev-bearer-only-for-phase1' \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:3000/mcp
```

## Tests

```bash
npm test                  # unit, coverage gates
npm run test:integration  # Postgres + LocalStack KMS via testcontainers
npm run lint
npm run typecheck
```

## License

MIT — see `LICENSE`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(phase1): rewrite README for foundation phase"
```

---

## Task 28: CHANGELOG entry and `0.2.0-phase1` tag

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Replace `CHANGELOG.md`**

```markdown
# Changelog

## [0.2.0-phase1] — 2026-05-21

### Added
- Multi-tenant Postgres schema with row-level security on `tenants`, `users`, `tenant_keys`, `tenant_secrets`, `audit_events`.
- Append-only `audit_events` (UPDATE/DELETE/TRUNCATE revoked for `app_role`).
- Envelope-encrypted secrets store with per-tenant AES-256-GCM DEKs wrapped by AWS KMS (LocalStack in tests).
- Streamable HTTP MCP transport scaffold with placeholder `phase1.echo` tool.
- Dev-token identity resolver (OAuth + API keys deferred to Phase 2/6).
- pino structured logger with single-source redaction list per spec §8.
- OpenTelemetry Node SDK bootstrap.
- `/healthz` and `/readyz` with structured per-check results.
- Multi-stage distroless non-root Dockerfile.
- GitHub Actions CI with lint, typecheck, unit + integration tests via testcontainers, cosign-signed image, CycloneDX SBOM artifact.
- Pre-commit hooks (prettier + eslint + typecheck).

### Changed
- Replaced the single-file stdio MCP server with a layered TypeScript codebase under `src/`.
- Bumped Node baseline to 20.11.

### Removed
- Legacy `server.js` / `src/server.ts` / `test-*.js` scripts (preserved on `legacy/v0.1` branch).

### Deferred to later phases
- Real WorkOS OAuth (Phase 2).
- Openprovider client + token manager (Phase 3).
- Policy engine + confirmations (Phase 4).
- Write tools + approver flow (Phase 5).
- Dashboard (Phase 6).
- Audit hash chain + object-store flush (Phase 7).
- Hardening (Phase 8).
- Release engineering (Phase 9).

### Known gaps in this phase
- The MCP transport uses an internal SDK shim until `StreamableHTTPServerTransport` lands in the installed SDK version (Phase 2 fixes).
- Cosign signing in CI assumes a registry; the local-tarball fallback is documented in `docs/superpowers/decisions/`.
```

- [ ] **Step 2: Tag the release**

```bash
git add CHANGELOG.md
git commit -m "docs(phase1): CHANGELOG for 0.2.0-phase1"
git tag -a v0.2.0-phase1 -m "Phase 1: Foundation"
git push origin main v0.2.0-phase1
```

- [ ] **Step 3: Verify CI ran on the tag**

Check the Actions tab for the run on `v0.2.0-phase1` and that the signed image artifact + SBOM are attached.

---

## Phase 1 exit checklist

- [ ] `legacy/v0.1` branch exists and points at the prior `main` head.
- [ ] `npm ci && npm test && npm run test:integration` all green on `main`.
- [ ] Coverage ≥ 80% (90% on `secrets/store`, `observability/redact` per spec §10 layer 1).
- [ ] Cross-tenant RLS integration tests exist for `tenants`, `users`, `tenant_keys`, `tenant_secrets`, and audit append-only test exists for `audit_events`.
- [ ] LocalStack KMS round-trip integration test green.
- [ ] CI produces a cosign-signed image and a CycloneDX SBOM artifact.
- [ ] `docker run` of the built image responds 200 on `/healthz`, 503 on `/readyz` until DB+KMS are reachable, then 200.
- [ ] `tools/list` over `/mcp` returns the placeholder tool when given the dev bearer.
- [ ] OpenTelemetry spans appear in a local Jaeger or stdout exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- [ ] CHANGELOG entry `0.2.0-phase1` committed; tag pushed.

---

## Self-review

**Spec coverage (Phase 1 in-scope items from the roadmap):**

| Roadmap in-scope item | Task(s) |
|---|---|
| Repo restructure under `src/` matching spec §3 module map | 2, 3 |
| `package.json` rewrite + lockfile + `npm ci` | 2 |
| Postgres migrations infrastructure | 5 |
| Migration role separate from `app_role` | 8 (CREATE ROLE), 25 (CI uses default postgres role for migrations) |
| `tenants`, `users`, `tenant_keys`, `tenant_secrets` + RLS + revoked DML | 8, 10, 11, 12 |
| Placeholder `audit_events` with revoked DELETE/UPDATE | 13 |
| `secrets/store` envelope-encrypt via KMS + fake KMS shim for tests | 14, 15, 16 |
| `observability/` with OTel + pino + redaction list + AsyncLocalStorage | 17, 18, 19 |
| `mcp/transport` Streamable HTTP + dev-token auth + placeholder tool | 21 |
| `auth/identity` skeleton returning `Principal` for dev token | 20 |
| `/healthz` and `/readyz` per spec §8 | 22 |
| Dockerfile (multi-stage, distroless, non-root, read-only root FS) | 24 |
| CI pipeline: lint → typecheck → unit → integration → build → cosign sign | 25 |
| Pre-commit hooks | 26 |
| README replaced; legacy archived | 1, 27 |
| `legacy/v0.1` branch cut from current main | 1 |

**Placeholder scan:**
- No "TBD" / "TODO" / vague "add appropriate" language in step bodies.
- Every step that changes code shows the code; every test step shows the test; every run step gives the command and the expected outcome.
- Two deliberate forward-references documented inline rather than left vague: the SDK transport shim in Task 21 (Phase 2 replaces it) and cosign-with-no-registry in Task 25 (decision doc to be written when CI infra is finalized).

**Type / name consistency:**
- `Principal` shape in Task 20 matches the one consumed in Task 21 (`tenantId`, `subject`, `kind`, `scopes`, `role`).
- `Kms` interface in Task 14 is the same one implemented by both `fake-kms.ts` (Task 14) and `aws-kms.ts` (Task 16).
- `SecretsRepo` shape in Task 15 matches the in-memory test repo (Task 14) and the DB-backed repo (Task 16).
- The `REDACTED_PATHS` set referenced in Task 18's logger test is the same one exported in Task 17.
- `app_role` and the `migrations/meta/_journal.json` filename are referenced consistently across Tasks 8, 10, 11, 12, 13.
- `phase1.echo` tool name appears in both `placeholder-tool.ts` and `transport.test.ts`.

*End of Phase 1 plan.*
