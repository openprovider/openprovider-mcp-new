# Enterprise Openprovider MCP — Phase 2: First End-to-End Vertical Slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real WorkOS OAuth authenticates an MCP client end-to-end and a `check_domain` tool call returns a typed result from Openprovider (via Nock-recorded fixtures in unit tests, real upstream when sandbox creds are provided). Every step is audited, traced, rate-limited, and proven for cross-tenant isolation.

**Architecture:** Phase 1's Fastify+Postgres+KMS+OTel foundation gains: WorkOS OAuth adapter, `.well-known` discovery endpoint, real bearer-token identity resolution, `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` replacing the Phase 1 JSON-RPC shim, an Openprovider HTTP client wrapped in a token manager + circuit breaker + retry, a tool-dispatch pipeline with audit-on-every-call, per-principal rate limits, and the first real tool (`check_domain`).

**Tech Stack additions:** `@workos-inc/node`, `nock`, `pg-boss` (introduced but unused until Phase 4), `opossum` (circuit breaker), `@fastify/rate-limit`.

**Source spec:** `docs/superpowers/specs/2026-05-21-enterprise-mcp-design.md` §§ 2, 3, 5 (Layer 1), 6 (read tools), 7 (errors)
**Source roadmap:** `docs/superpowers/plans/2026-05-21-enterprise-mcp-roadmap.md` § Phase 2
**Phase 1 plan (prerequisite):** `docs/superpowers/plans/2026-05-21-enterprise-mcp-phase-1-foundation.md`

**Decisions locked in this plan:**
- Stack onto `feat/enterprise-phase-1` (no new branch).
- WorkOS account setup is Task 1 (interactive, manual checklist for the human).
- Tests use Nock fixtures for Openprovider; live sandbox suite is opt-in and runs nightly in CI (deferred to Phase 3 plan).
- WorkOS sandbox project for dev; production project provisioned later.
- Per-principal rate limit default: 60 reads/min, 10 writes/min (matches spec §5).

---

## Task ordering rationale

1. **Tasks 1–3:** WorkOS provisioning + env wiring. Without WorkOS keys, nothing further works locally.
2. **Tasks 4–6:** Auth surface — OAuth introspection adapter, identity resolver upgrade, discovery endpoint.
3. **Tasks 7–9:** Transport upgrade to MCP SDK StreamableHTTPServerTransport with session IDs + SSE.
4. **Tasks 10–13:** Openprovider client (just `check_domain`), retry/timeout, circuit breaker, error mapping.
5. **Tasks 14–16:** Openprovider token manager (per-tenant login, singleflight, 401 retry, in-memory + Postgres backstop).
6. **Tasks 17–19:** Tool dispatch pipeline (validate → audit-row insert → call → audit-row insert), `check_domain` tool definition, wire into transport.
7. **Tasks 20–22:** Cross-tenant isolation E2E, OAuth happy-path E2E, per-principal rate limit middleware.
8. **Task 23:** CHANGELOG + `v0.2.0-phase2` tag.

---

## Task 1: WorkOS account + AuthKit project (manual, interactive)

**Files:** none committed — this task produces credentials you paste into `.env` and a docs note.

This task is performed by a human and **cannot be done by a subagent**. The implementer subagent should pause and report `NEEDS_CONTEXT` with the checklist below; the controller surfaces it to the user, the user completes the steps, and the user pastes the resulting values back.

- [ ] **Step 1: Sign up at https://workos.com** (free tier covers all of Phase 2). Use the same email you use for billable services.

- [ ] **Step 2: Create an organization** in the WorkOS dashboard. Name it something like `openprovider-mcp-dev` for the dev environment; production is provisioned later.

- [ ] **Step 3: Enable AuthKit** for that organization. AuthKit is WorkOS's hosted UI + OAuth 2.1 server.

- [ ] **Step 4: Configure redirect URIs** for AuthKit. For local dev, add:
  - `http://localhost:3000/oauth/callback`
  - `http://localhost:3000/dashboard/login/callback`
  - (Phase 6 adds dashboard URIs)

- [ ] **Step 5: Copy the following values** from the WorkOS dashboard:
  - **Client ID** (begins with `client_`)
  - **API Key** (begins with `sk_test_` for the sandbox)
  - **AuthKit Domain** (e.g. `https://your-org.authkit.app` or a custom domain)
  - **JWKS URI** (typically `https://api.workos.com/sso/jwks/{client_id}`)

- [ ] **Step 6: Save them to your local `.env`** (do not commit):
  ```
  WORKOS_CLIENT_ID=client_xxxxxxxxxxxxxxxx
  WORKOS_API_KEY=sk_test_xxxxxxxxxxxxxxxx
  WORKOS_AUTHKIT_DOMAIN=https://your-org.authkit.app
  WORKOS_JWKS_URI=https://api.workos.com/sso/jwks/client_xxxxxxxxxxxxxxxx
  WORKOS_ISSUER=https://api.workos.com
  ```

- [ ] **Step 7: Create a decision record** documenting the WorkOS project provisioning:

  Create `docs/superpowers/decisions/2026-05-22-workos-dev-project.md`:

  ```markdown
  # WorkOS Dev Project Provisioning

  - Date: 2026-05-22
  - Organization: openprovider-mcp-dev (WorkOS)
  - Environment: sandbox (sk_test_*)
  - AuthKit redirect URIs registered:
    - http://localhost:3000/oauth/callback
    - http://localhost:3000/dashboard/login/callback
  - Production WorkOS organization deferred to Phase 9.
  - JWKS rotation policy: WorkOS-managed; keys cached locally for 1 h.
  ```

- [ ] **Step 8: Commit the decision record only** (env values stay local):

  ```bash
  git add docs/superpowers/decisions/2026-05-22-workos-dev-project.md
  git commit -m "docs(phase2): WorkOS dev project provisioning decision record"
  ```

**Exit criteria for Task 1:** `.env` contains all five `WORKOS_*` values; the decision record is committed; the user reports `WORKOS_OK` back to the controller before Task 2 starts.

---

## Task 2: Extend `src/config.ts` for WorkOS env vars

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Update zod schema in `src/config.ts`** — add these fields to the schema object:

  ```ts
  WORKOS_CLIENT_ID: z.string().min(1),
  WORKOS_API_KEY: z.string().min(1),
  WORKOS_AUTHKIT_DOMAIN: z.string().url(),
  WORKOS_JWKS_URI: z.string().url(),
  WORKOS_ISSUER: z.string().url().default('https://api.workos.com'),
  ```

  And in the return object:

  ```ts
  workosClientId: parsed.WORKOS_CLIENT_ID,
  workosApiKey: parsed.WORKOS_API_KEY,
  workosAuthkitDomain: parsed.WORKOS_AUTHKIT_DOMAIN,
  workosJwksUri: parsed.WORKOS_JWKS_URI,
  workosIssuer: parsed.WORKOS_ISSUER,
  ```

- [ ] **Step 2: Update `src/config.test.ts`** — every existing test that supplies a full env must now also include the five `WORKOS_*` values. Add a new test that asserts the schema rejects missing `WORKOS_CLIENT_ID`:

  ```ts
  it('throws if WORKOS_CLIENT_ID is missing', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        AWS_KMS_KEY_ARN: 'alias/x',
        DEV_BEARER_TOKEN: 'dev',
      }),
    ).toThrow(/WORKOS_CLIENT_ID/);
  });
  ```

  Also bump every other test fixture to include the five WORKOS values.

- [ ] **Step 3: Update `.env.example`** — append:

  ```
  WORKOS_CLIENT_ID=client_replace_me
  WORKOS_API_KEY=sk_test_replace_me
  WORKOS_AUTHKIT_DOMAIN=https://your-org.authkit.app
  WORKOS_JWKS_URI=https://api.workos.com/sso/jwks/client_replace_me
  WORKOS_ISSUER=https://api.workos.com
  ```

- [ ] **Step 4: Verify**

  ```bash
  npm test -- config
  npm run typecheck
  npm run lint
  ```

  All exit 0.

- [ ] **Step 5: Commit**

  ```bash
  git add src/config.ts src/config.test.ts .env.example
  git commit -m "feat(phase2): config schema for WorkOS env vars"
  ```

---

## Task 3: Install Phase 2 dependencies

- [ ] **Step 1: Install**

  ```bash
  npm install @workos-inc/node opossum @fastify/rate-limit
  npm install --save-dev nock @types/opossum
  ```

- [ ] **Step 2: Typecheck**

  ```bash
  npm run typecheck
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add package.json package-lock.json
  git commit -m "build(phase2): add @workos-inc/node, opossum, rate-limit, nock"
  ```

---

## Task 4: OAuth introspection adapter — `auth/oauth/workos.ts`

**Files:**
- Create: `src/auth/oauth/workos.ts`
- Create: `src/auth/oauth/workos.test.ts`

The WorkOS adapter validates a bearer JWT by fetching JWKS (cached) and verifying the signature + `iss`/`aud` claims. It exposes `verifyAccessToken(token)` returning `{ subject, scopes, tenantId, expiresAt }` or throwing `OAuthVerificationError`.

- [ ] **Step 1: Write failing test `src/auth/oauth/workos.test.ts`**

  ```ts
  import { describe, expect, it, beforeAll } from 'vitest';
  import { createWorkOsVerifier, OAuthVerificationError } from './workos.js';
  import { SignJWT, exportJWK, generateKeyPair } from 'jose';
  import nock from 'nock';

  describe('workos verifier', () => {
    let signKey: CryptoKey;
    let publicJwk: Record<string, unknown>;

    beforeAll(async () => {
      const kp = await generateKeyPair('RS256');
      signKey = kp.privateKey;
      const pub = await exportJWK(kp.publicKey);
      pub.kid = 'test-kid';
      pub.alg = 'RS256';
      publicJwk = pub;
    });

    function mockJwks(uri: string) {
      const url = new URL(uri);
      nock(url.origin).get(url.pathname).reply(200, { keys: [publicJwk] });
    }

    async function token(claims: Record<string, unknown>): Promise<string> {
      return await new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuer('https://api.workos.com')
        .setAudience('client_test')
        .setExpirationTime('5m')
        .sign(signKey);
    }

    it('verifies a valid token and returns claims', async () => {
      mockJwks('https://api.workos.com/sso/jwks/client_test');
      const verify = createWorkOsVerifier({
        clientId: 'client_test',
        issuer: 'https://api.workos.com',
        jwksUri: 'https://api.workos.com/sso/jwks/client_test',
      });
      const t = await token({ sub: 'user_123', scope: 'mcp:read mcp:write', 'act.tnt': 'tnt_a' });
      const claims = await verify(t);
      expect(claims.subject).toBe('user_123');
      expect(claims.scopes).toEqual(['mcp:read', 'mcp:write']);
      expect(claims.tenantId).toBe('tnt_a');
    });

    it('rejects an expired token', async () => {
      mockJwks('https://api.workos.com/sso/jwks/client_test');
      const verify = createWorkOsVerifier({
        clientId: 'client_test',
        issuer: 'https://api.workos.com',
        jwksUri: 'https://api.workos.com/sso/jwks/client_test',
      });
      const t = await new SignJWT({ sub: 'u', scope: 'mcp:read', 'act.tnt': 't' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuer('https://api.workos.com')
        .setAudience('client_test')
        .setExpirationTime('-1m')
        .sign(signKey);
      await expect(verify(t)).rejects.toBeInstanceOf(OAuthVerificationError);
    });

    it('rejects a wrong-audience token', async () => {
      mockJwks('https://api.workos.com/sso/jwks/client_test');
      const verify = createWorkOsVerifier({
        clientId: 'client_test',
        issuer: 'https://api.workos.com',
        jwksUri: 'https://api.workos.com/sso/jwks/client_test',
      });
      const t = await new SignJWT({ sub: 'u', scope: 'mcp:read', 'act.tnt': 't' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuer('https://api.workos.com')
        .setAudience('client_other')
        .setExpirationTime('5m')
        .sign(signKey);
      await expect(verify(t)).rejects.toBeInstanceOf(OAuthVerificationError);
    });

    it('rejects a token without act.tnt claim', async () => {
      mockJwks('https://api.workos.com/sso/jwks/client_test');
      const verify = createWorkOsVerifier({
        clientId: 'client_test',
        issuer: 'https://api.workos.com',
        jwksUri: 'https://api.workos.com/sso/jwks/client_test',
      });
      const t = await token({ sub: 'u', scope: 'mcp:read' });
      await expect(verify(t)).rejects.toBeInstanceOf(OAuthVerificationError);
    });
  });
  ```

  Install `jose` for JWT helpers (it's a transitive of `@workos-inc/node`; if not, `npm install jose`).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Write `src/auth/oauth/workos.ts`**

  ```ts
  import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';

  export class OAuthVerificationError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
      super(message);
      this.name = 'OAuthVerificationError';
    }
  }

  export interface WorkOsVerifierConfig {
    clientId: string;
    issuer: string;
    jwksUri: string;
  }

  export interface VerifiedClaims {
    subject: string;
    scopes: string[];
    tenantId: string;
    expiresAt: Date;
  }

  export type AccessTokenVerifier = (token: string) => Promise<VerifiedClaims>;

  export function createWorkOsVerifier(config: WorkOsVerifierConfig): AccessTokenVerifier {
    const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
      cacheMaxAge: 60 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
    return async (token: string): Promise<VerifiedClaims> => {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.clientId,
          algorithms: ['RS256'],
        });
        const sub = typeof payload.sub === 'string' ? payload.sub : '';
        const scopeStr = typeof payload['scope'] === 'string' ? (payload['scope'] as string) : '';
        const tnt = typeof payload['act.tnt'] === 'string' ? (payload['act.tnt'] as string) : '';
        if (!sub) throw new OAuthVerificationError('missing sub claim');
        if (!tnt) throw new OAuthVerificationError('missing act.tnt claim');
        return {
          subject: sub,
          scopes: scopeStr ? scopeStr.split(' ').filter(Boolean) : [],
          tenantId: tnt,
          expiresAt: payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 60_000),
        };
      } catch (err) {
        if (err instanceof OAuthVerificationError) throw err;
        if (err instanceof joseErrors.JOSEError) {
          throw new OAuthVerificationError(`token verification failed: ${err.code}`, err);
        }
        throw new OAuthVerificationError('token verification failed', err);
      }
    };
  }
  ```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

  ```bash
  git add src/auth/oauth/workos.ts src/auth/oauth/workos.test.ts package.json package-lock.json
  git commit -m "feat(phase2): WorkOS access-token verifier with JWKS cache + claim assertions"
  ```

---

## Task 5: Identity resolver — real OAuth path

**Files:**
- Modify: `src/auth/identity.ts`
- Modify: `src/auth/identity.test.ts`

The resolver now accepts an optional `verifier: AccessTokenVerifier`. If supplied, any bearer that is not the dev token and not an `op_live_` API key is fed to the verifier. On success, the resolver maps `VerifiedClaims` to a `Principal` of kind `user`.

- [ ] **Step 1: Extend `src/auth/identity.test.ts`** — add new cases:

  ```ts
  it('resolves a real OAuth bearer to a user Principal', async () => {
    const fakeVerifier = async (token: string) => {
      if (token !== 'oauth_real') throw new Error('nope');
      return {
        subject: 'user_42',
        scopes: ['mcp:read'],
        tenantId: 'tnt_xyz',
        expiresAt: new Date(Date.now() + 60_000),
      };
    };
    const resolve = createIdentityResolver({
      devToken: 'dev-bearer',
      devPrincipal: {
        kind: 'user',
        tenantId: 't',
        userId: 'u',
        subject: 'dev',
        scopes: [],
        role: 'owner',
      },
      verifier: fakeVerifier,
    });
    const p = await resolve('Bearer oauth_real');
    expect(p?.kind).toBe('user');
    if (p?.kind === 'user') {
      expect(p.subject).toBe('user_42');
      expect(p.tenantId).toBe('tnt_xyz');
      expect(p.scopes).toEqual(['mcp:read']);
    }
  });

  it('returns null when verifier rejects', async () => {
    const fakeVerifier = async () => { throw new Error('bad'); };
    const resolve = createIdentityResolver({
      devToken: 'dev-bearer',
      devPrincipal: {
        kind: 'user',
        tenantId: 't',
        userId: 'u',
        subject: 'dev',
        scopes: [],
        role: 'owner',
      },
      verifier: fakeVerifier,
    });
    expect(await resolve('Bearer some_bad_token')).toBeNull();
  });
  ```

- [ ] **Step 2: Update `src/auth/identity.ts`**:

  ```ts
  import type { Principal } from './principal.js';
  import type { AccessTokenVerifier } from './oauth/workos.js';

  export interface IdentityResolverConfig {
    devToken: string;
    devPrincipal: Principal;
    verifier?: AccessTokenVerifier;
  }

  export type IdentityResolver = (
    authorizationHeader: string | undefined,
  ) => Promise<Principal | null>;

  export function createIdentityResolver(config: IdentityResolverConfig): IdentityResolver {
    return async (header) => {
      if (!header) return null;
      const parts = header.split(' ');
      const scheme = parts[0];
      const token = parts[1];
      if (scheme !== 'Bearer' || !token) return null;
      if (token === config.devToken) return config.devPrincipal;
      if (token.startsWith('op_live_')) {
        throw new Error('API key authentication lands in phase 6');
      }
      if (config.verifier) {
        try {
          const claims = await config.verifier(token);
          return {
            kind: 'user',
            tenantId: claims.tenantId,
            userId: claims.subject,
            subject: claims.subject,
            scopes: claims.scopes,
            role: claims.scopes.includes('mcp:write') ? 'operator' : 'viewer',
          };
        } catch {
          return null;
        }
      }
      return null;
    };
  }
  ```

  > Role assignment from scopes is a temporary mapping until Phase 6 introduces real RBAC stored in the `users` table. Document this in the commit message.

- [ ] **Step 3: Run, expect PASS** (existing tests + new ones).

- [ ] **Step 4: Commit**

  ```bash
  git add src/auth/identity.ts src/auth/identity.test.ts
  git commit -m "feat(phase2): identity resolver consumes WorkOS bearer via injected verifier

  Role is provisionally derived from scopes (mcp:write -> operator else viewer);
  Phase 6 replaces this with persisted RBAC from the users table."
  ```

---

## Task 6: `.well-known/oauth-protected-resource` discovery endpoint

**Files:**
- Modify: `src/mcp/transport.ts`
- Create: `src/mcp/discovery.test.ts`

Per the MCP spec (2025-06+), an MCP server publishes a JSON document at this path advertising the authorization server URL, supported scopes, and resource identifier. Spec-aware MCP clients fetch it during connection.

- [ ] **Step 1: Write failing test `src/mcp/discovery.test.ts`**

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import type { FastifyInstance } from 'fastify';
  import { createMcpServer } from './transport.js';
  import type { Principal } from '../auth/principal.js';

  const devPrincipal: Principal = {
    kind: 'user', tenantId: 't', userId: 'u', subject: 'dev', scopes: [], role: 'owner',
  };

  describe('well-known discovery', () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await createMcpServer({
        devToken: 'dev',
        devPrincipal,
        oauth: {
          authorizationServer: 'https://your-org.authkit.app',
          resource: 'https://mcp.example.com',
          scopesSupported: ['mcp:read', 'mcp:write'],
        },
      });
      await app.ready();
    });
    afterAll(async () => app.close());

    it('serves /.well-known/oauth-protected-resource', async () => {
      const r = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
      expect(r.statusCode).toBe(200);
      const body = r.json() as Record<string, unknown>;
      expect(body.resource).toBe('https://mcp.example.com');
      expect(body.authorization_servers).toEqual(['https://your-org.authkit.app']);
      expect(body.scopes_supported).toEqual(['mcp:read', 'mcp:write']);
      expect(body.bearer_methods_supported).toContain('header');
    });

    it('serves /.well-known/oauth-protected-resource when no oauth config (open mode)', async () => {
      const open = await createMcpServer({ devToken: 'dev', devPrincipal });
      await open.ready();
      const r = await open.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
      expect(r.statusCode).toBe(404);
      await open.close();
    });
  });
  ```

- [ ] **Step 2: Extend `McpServerConfig`** in `src/mcp/transport.ts`:

  ```ts
  export interface McpServerConfig {
    devToken: string;
    devPrincipal: Principal;
    readinessChecks?: { name: string; check: () => Promise<boolean> }[];
    oauth?: {
      authorizationServer: string;
      resource: string;
      scopesSupported: string[];
    };
  }
  ```

  Inside `createMcpServer` (before the `/mcp` route), if `config.oauth` is present:

  ```ts
  if (config.oauth) {
    const oauth = config.oauth;
    app.get('/.well-known/oauth-protected-resource', () =>
      Promise.resolve({
        resource: oauth.resource,
        authorization_servers: [oauth.authorizationServer],
        scopes_supported: oauth.scopesSupported,
        bearer_methods_supported: ['header'],
      }),
    );
  }
  ```

  When `config.oauth` is absent, the route is not registered and Fastify naturally returns 404.

- [ ] **Step 3: Run, expect PASS.**

- [ ] **Step 4: Commit**

  ```bash
  git add src/mcp/transport.ts src/mcp/discovery.test.ts
  git commit -m "feat(phase2): /.well-known/oauth-protected-resource discovery endpoint"
  ```

---

## Task 7: Streamable HTTP transport — replace the Phase 1 shim

**Files:**
- Modify: `src/mcp/transport.ts`
- Modify: `src/mcp/transport.test.ts`
- Create: `src/mcp/sdk-transport.ts`

Replace the manual JSON-RPC routing with the MCP SDK's `StreamableHTTPServerTransport`, mounted under Fastify. Sessions, SSE, and protocol-level error envelopes come for free from the SDK.

- [ ] **Step 1: Add a Server creation helper `src/mcp/sdk-transport.ts`**

  ```ts
  import { Server } from '@modelcontextprotocol/sdk/server/index.js';
  import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } from '@modelcontextprotocol/sdk/types.js';
  import { zodToJsonSchema } from 'zod-to-json-schema';
  import { placeholderTool } from './placeholder-tool.js';

  export interface ToolEntry {
    name: string;
    description: string;
    inputSchema: { parse: (raw: unknown) => unknown } & { _def?: unknown };
    handler: (input: unknown) => Promise<unknown>;
  }

  const TOOLS: ToolEntry[] = [placeholderTool as unknown as ToolEntry];

  export function registerTool(tool: ToolEntry): void {
    if (!TOOLS.find((t) => t.name === tool.name)) TOOLS.push(tool);
  }

  export function createMcpSdkServer(): Server {
    const server = new Server(
      { name: 'openprovider-mcp', version: '0.2.0-phase2' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.inputSchema as never) as Record<string, unknown>,
        })),
      }),
    );

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = TOOLS.find((t) => t.name === req.params.name);
      if (!tool) throw new Error(`Tool not found: ${req.params.name}`);
      const parsed = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(parsed);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });

    return server;
  }
  ```

- [ ] **Step 2: Replace `/mcp` handler** in `src/mcp/transport.ts` — drop the JSON-RPC routing block. Replace with a per-session bridge to `StreamableHTTPServerTransport`:

  ```ts
  import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
  import { createMcpSdkServer } from './sdk-transport.js';
  import { randomUUID } from 'node:crypto';

  // ... inside createMcpServer, replace the body of the /mcp POST handler:

  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  app.post('/mcp', async (req, reply) => {
    const principal = await resolve(req.headers.authorization);
    if (!principal) {
      void reply.code(401);
      return { error: 'unauthenticated' };
    }
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? randomUUID();
    let entry = sessions.get(sessionId);
    if (!entry) {
      const server = createMcpSdkServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      await server.connect(transport);
      entry = { server, transport };
      sessions.set(sessionId, entry);
    }
    return withRequestContext(
      {
        tenantId: principal.tenantId,
        principalSubject: principal.subject,
        principalKind: principal.kind,
      },
      () => entry!.transport.handleRequest(req.raw, reply.raw, req.body),
    );
  });

  app.get('/mcp', async (req, reply) => {
    const principal = await resolve(req.headers.authorization);
    if (!principal) { void reply.code(401); return { error: 'unauthenticated' }; }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) { void reply.code(400); return { error: 'mcp-session-id required for SSE' }; }
    const entry = sessions.get(sessionId);
    if (!entry) { void reply.code(404); return { error: 'session not found' }; }
    return entry.transport.handleRequest(req.raw, reply.raw);
  });
  ```

- [ ] **Step 3: Update `src/mcp/transport.test.ts`** — the existing tests use `app.inject()` and direct JSON-RPC bodies. With the SDK transport, the wire format is unchanged for `tools/list` and `tools/call`, so most tests should still pass. The `unknown method returns -32601` test must be updated — the SDK transport returns `-32601` itself for unrecognized JSON-RPC methods; verify the wire body still has `error.code === -32601`.

  If a test fails because `app.inject()` doesn't properly feed `req.raw`/`reply.raw` to `transport.handleRequest`, switch that test to use the live listening port via `await app.listen({ port: 0 })` and undici's `fetch`. The SDK transport reads from the raw Node `IncomingMessage` — Fastify's inject path may not surface streaming properly.

  > **If tests can't be made to pass via inject:** add a single integration-style test under `tests/integration/mcp/` that starts the Fastify server on an ephemeral port and exercises the wire protocol end-to-end. Keep the unit test surface for the auth checks (401) and route registration only.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

  ```bash
  git add src/mcp/transport.ts src/mcp/sdk-transport.ts src/mcp/transport.test.ts
  git commit -m "feat(phase2): adopt MCP SDK StreamableHTTPServerTransport with session tracking"
  ```

---

## Task 8: Wire WorkOS verifier into `src/server.ts` composition root

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: In `main()`** — after loading config, construct the verifier and pass it to `createMcpServer`:

  ```ts
  import { createWorkOsVerifier } from './auth/oauth/workos.js';

  // ... after const cfg = loadConfig();

  const verifier = createWorkOsVerifier({
    clientId: cfg.workosClientId,
    issuer: cfg.workosIssuer,
    jwksUri: cfg.workosJwksUri,
  });

  const app = await createMcpServer({
    devToken: cfg.devBearerToken,
    devPrincipal,
    verifier,
    oauth: {
      authorizationServer: cfg.workosAuthkitDomain,
      resource: `http://localhost:${cfg.port}`,
      scopesSupported: ['mcp:read', 'mcp:write'],
    },
    readinessChecks: [ /* unchanged */ ],
  });
  ```

  Also extend `McpServerConfig` to accept `verifier?: AccessTokenVerifier` and forward it to `createIdentityResolver`.

- [ ] **Step 2: Build + smoke**

  ```bash
  npm run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/server.ts src/mcp/transport.ts
  git commit -m "feat(phase2): wire WorkOS verifier into composition root"
  ```

---

## Task 9: Update Dockerfile + .env.example so the container actually boots

**Files:**
- Modify: `Dockerfile` (no change expected — already copies what it needs)
- Modify: `.env.example`

- [ ] **Step 1: Verify `.env.example`** already has the WORKOS_* values from Task 2. If not, add them.

- [ ] **Step 2: Rebuild image to be sure**

  ```bash
  docker build -t openprovider-mcp:phase2-wip .
  ```

  Exit 0.

- [ ] **Step 3: Commit** (only if a file changed)

  ```bash
  git status -s
  ```

  If nothing changed, skip. Otherwise:

  ```bash
  git add Dockerfile .env.example
  git commit -m "chore(phase2): docker + .env.example refreshed for WORKOS env"
  ```

---

## Task 10: Openprovider HTTP client scaffold — `openprovider/client.ts`

**Files:**
- Create: `src/openprovider/types.ts`
- Create: `src/openprovider/errors.ts`
- Create: `src/openprovider/client.ts`
- Create: `src/openprovider/client.test.ts`

- [ ] **Step 1: Write `src/openprovider/errors.ts`**

  ```ts
  export class OpenproviderAuthError extends Error {
    constructor(message: string) { super(message); this.name = 'OpenproviderAuthError'; }
  }
  export class OpenproviderRateLimitError extends Error {
    constructor(message: string, public retryAfterMs?: number) {
      super(message); this.name = 'OpenproviderRateLimitError';
    }
  }
  export class OpenproviderUnavailableError extends Error {
    constructor(message: string) { super(message); this.name = 'OpenproviderUnavailableError'; }
  }
  export class OpenproviderClientError extends Error {
    constructor(message: string, public status: number, public upstreamCode?: string) {
      super(message); this.name = 'OpenproviderClientError';
    }
  }
  ```

- [ ] **Step 2: Write `src/openprovider/types.ts`** — typed shape of `check_domain` response:

  ```ts
  import { z } from 'zod';

  export const CheckDomainArgs = z.object({
    domains: z.array(z.object({
      name: z.string().min(1),
      extension: z.string().min(1),
    })).min(1).max(50),
    with_price: z.boolean().default(true),
  });
  export type CheckDomainArgs = z.infer<typeof CheckDomainArgs>;

  export const CheckDomainResult = z.object({
    results: z.array(z.object({
      domain: z.string(),
      status: z.string(),
      is_premium: z.boolean().optional(),
      price: z.object({
        product: z.object({
          price: z.number(),
          currency: z.string(),
        }).optional(),
      }).optional(),
    })),
  });
  export type CheckDomainResult = z.infer<typeof CheckDomainResult>;
  ```

  > The exact shape is from the Postman collection's `POST /domains/check` response. Adjust the schema if the real shape differs — the Phase 3 plan documents how to regenerate this from Openprovider's OpenAPI spec when one becomes available.

- [ ] **Step 3: Write `src/openprovider/client.ts`** — a slim HTTP wrapper using `fetch` with timeouts + retries:

  ```ts
  import {
    OpenproviderAuthError,
    OpenproviderRateLimitError,
    OpenproviderUnavailableError,
    OpenproviderClientError,
  } from './errors.js';
  import { CheckDomainArgs, CheckDomainResult } from './types.js';

  export interface OpenproviderClientConfig {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  }

  export interface OpenproviderClient {
    checkDomain(token: string, args: CheckDomainArgs): Promise<CheckDomainResult>;
  }

  const DEFAULT_BASE = 'https://api.openprovider.eu/v1beta';

  export function createOpenproviderClient(config: OpenproviderClientConfig = {}): OpenproviderClient {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE;
    const fetcher = config.fetchImpl ?? fetch;

    async function request(method: string, path: string, token: string, body?: unknown): Promise<unknown> {
      const attempt = async (n: number): Promise<unknown> => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30_000);
        try {
          const res = await fetcher(`${baseUrl}${path}`, {
            method,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
              'user-agent': 'openprovider-mcp/0.2.0-phase2',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctrl.signal,
          });
          if (res.status >= 500) {
            if (n < 3) {
              await new Promise((r) => setTimeout(r, [250, 1000, 4000][n] ?? 4000));
              return attempt(n + 1);
            }
            throw new OpenproviderUnavailableError(`upstream ${res.status}`);
          }
          if (res.status === 429) {
            const retryAfter = res.headers.get('retry-after');
            if (n < 2) {
              await new Promise((r) =>
                setTimeout(r, retryAfter ? Number(retryAfter) * 1000 : 1000),
              );
              return attempt(n + 1);
            }
            throw new OpenproviderRateLimitError('upstream 429');
          }
          if (res.status === 401) throw new OpenproviderAuthError('upstream 401');
          if (res.status >= 400) {
            const text = await res.text();
            throw new OpenproviderClientError(`upstream ${res.status}: ${text.slice(0, 200)}`, res.status);
          }
          return (await res.json()) as unknown;
        } finally {
          clearTimeout(timer);
        }
      };
      return attempt(0);
    }

    return {
      async checkDomain(token, args) {
        const parsedArgs = CheckDomainArgs.parse(args);
        const body = await request('POST', '/domains/check', token, parsedArgs);
        // Openprovider responses are wrapped as { data: { ... } }.
        const data = (body as { data?: unknown }).data ?? body;
        return CheckDomainResult.parse(data);
      },
    };
  }
  ```

- [ ] **Step 4: Write `src/openprovider/client.test.ts`** with Nock fixtures:

  ```ts
  import { afterEach, describe, expect, it } from 'vitest';
  import nock from 'nock';
  import { createOpenproviderClient } from './client.js';
  import {
    OpenproviderAuthError,
    OpenproviderClientError,
    OpenproviderRateLimitError,
    OpenproviderUnavailableError,
  } from './errors.js';

  describe('openprovider client — check_domain', () => {
    afterEach(() => nock.cleanAll());

    it('parses a 200 response with a price', async () => {
      nock('https://api.openprovider.eu')
        .post('/v1beta/domains/check')
        .reply(200, {
          data: {
            results: [
              {
                domain: 'example.com',
                status: 'free',
                is_premium: false,
                price: { product: { price: 9.99, currency: 'EUR' } },
              },
            ],
          },
        });
      const client = createOpenproviderClient();
      const r = await client.checkDomain('tok', {
        domains: [{ name: 'example', extension: 'com' }],
        with_price: true,
      });
      expect(r.results[0]?.domain).toBe('example.com');
      expect(r.results[0]?.price?.product?.price).toBe(9.99);
    });

    it('throws OpenproviderAuthError on 401', async () => {
      nock('https://api.openprovider.eu').post('/v1beta/domains/check').reply(401, { error: 'bad token' });
      const client = createOpenproviderClient();
      await expect(
        client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
      ).rejects.toBeInstanceOf(OpenproviderAuthError);
    });

    it('retries on 5xx then succeeds', async () => {
      nock('https://api.openprovider.eu').post('/v1beta/domains/check').reply(503);
      nock('https://api.openprovider.eu').post('/v1beta/domains/check').reply(200, {
        data: { results: [{ domain: 'x.com', status: 'free' }] },
      });
      const client = createOpenproviderClient();
      const r = await client.checkDomain('tok', {
        domains: [{ name: 'x', extension: 'com' }],
        with_price: false,
      });
      expect(r.results[0]?.status).toBe('free');
    }, 10_000);

    it('throws OpenproviderUnavailableError after 5xx retries exhausted', async () => {
      nock('https://api.openprovider.eu').post('/v1beta/domains/check').times(4).reply(503);
      const client = createOpenproviderClient();
      await expect(
        client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
      ).rejects.toBeInstanceOf(OpenproviderUnavailableError);
    }, 15_000);

    it('respects Retry-After on 429 once', async () => {
      nock('https://api.openprovider.eu').post('/v1beta/domains/check').reply(429, '', { 'retry-after': '0' });
      nock('https://api.openprovider.eu').post('/v1beta/domains/check').reply(200, {
        data: { results: [{ domain: 'a.com', status: 'free' }] },
      });
      const client = createOpenproviderClient();
      const r = await client.checkDomain('tok', {
        domains: [{ name: 'a', extension: 'com' }],
        with_price: false,
      });
      expect(r.results[0]?.domain).toBe('a.com');
    });

    it('throws OpenproviderClientError on 4xx (non-401/429)', async () => {
      nock('https://api.openprovider.eu').post('/v1beta/domains/check').reply(400, { error: 'bad input' });
      const client = createOpenproviderClient();
      await expect(
        client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
      ).rejects.toBeInstanceOf(OpenproviderClientError);
    });

    it('validates args via zod', async () => {
      const client = createOpenproviderClient();
      await expect(
        client.checkDomain('tok', { domains: [], with_price: false } as never),
      ).rejects.toThrow(/at least 1|too small/i);
    });
  });
  ```

- [ ] **Step 5: Run, expect PASS.**

- [ ] **Step 6: Commit**

  ```bash
  git add src/openprovider/
  git commit -m "feat(phase2): openprovider client with check_domain + retry/timeout/error mapping"
  ```

---

## Task 11: Circuit breaker around the Openprovider client

**Files:**
- Modify: `src/openprovider/client.ts`
- Create: `src/openprovider/circuit-breaker.test.ts`

- [ ] **Step 1: Write a circuit-breaker wrapper test**

  ```ts
  // src/openprovider/circuit-breaker.test.ts
  import { describe, expect, it, beforeEach, afterEach } from 'vitest';
  import nock from 'nock';
  import { createOpenproviderClient } from './client.js';
  import { OpenproviderUnavailableError } from './errors.js';

  describe('openprovider client — circuit breaker', () => {
    afterEach(() => nock.cleanAll());

    it('opens the circuit after sustained failures and fast-fails', async () => {
      // 20 consecutive 5xx (retries exhausted each call) opens the breaker.
      nock('https://api.openprovider.eu').post('/v1beta/domains/check').times(80).reply(503);
      const client = createOpenproviderClient({ breakerOptions: { volumeThreshold: 10, errorThresholdPercentage: 50, resetTimeout: 30_000 } });
      // First 10 calls drain volume / trip breaker.
      for (let i = 0; i < 10; i++) {
        await expect(
          client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
        ).rejects.toBeInstanceOf(OpenproviderUnavailableError);
      }
      // The next call should fast-fail without hitting nock (the unconsumed interceptors will still be there).
      const before = nock.pendingMocks().length;
      await expect(
        client.checkDomain('tok', { domains: [{ name: 'x', extension: 'com' }], with_price: false }),
      ).rejects.toBeInstanceOf(OpenproviderUnavailableError);
      const after = nock.pendingMocks().length;
      expect(after).toBe(before); // No additional interceptor consumed.
    }, 30_000);
  });
  ```

- [ ] **Step 2: Modify `src/openprovider/client.ts`** to wrap each endpoint's `request` call in an opossum `CircuitBreaker`:

  Add to `OpenproviderClientConfig`:

  ```ts
  breakerOptions?: {
    timeout?: number;
    errorThresholdPercentage?: number;
    volumeThreshold?: number;
    resetTimeout?: number;
  };
  ```

  Wire opossum:

  ```ts
  import CircuitBreaker from 'opossum';

  // inside createOpenproviderClient
  const checkDomainBreaker = new CircuitBreaker(
    (token: string, args: CheckDomainArgs) => request('POST', '/domains/check', token, args),
    {
      timeout: config.breakerOptions?.timeout ?? 60_000,
      errorThresholdPercentage: config.breakerOptions?.errorThresholdPercentage ?? 50,
      volumeThreshold: config.breakerOptions?.volumeThreshold ?? 20,
      resetTimeout: config.breakerOptions?.resetTimeout ?? 30_000,
    },
  );
  checkDomainBreaker.fallback(() => {
    throw new OpenproviderUnavailableError('circuit open');
  });

  // checkDomain method body becomes:
  return {
    async checkDomain(token, args) {
      const parsedArgs = CheckDomainArgs.parse(args);
      const body = (await checkDomainBreaker.fire(token, parsedArgs)) as { data?: unknown } | unknown;
      const data = (body as { data?: unknown }).data ?? body;
      return CheckDomainResult.parse(data);
    },
  };
  ```

- [ ] **Step 3: Run all openprovider tests, expect PASS.**

- [ ] **Step 4: Commit**

  ```bash
  git add src/openprovider/
  git commit -m "feat(phase2): per-endpoint circuit breaker around openprovider client"
  ```

---

## Task 12: Per-tenant Openprovider token manager

**Files:**
- Create: `src/openprovider/token-manager.ts`
- Create: `src/openprovider/token-manager.test.ts`

The token manager fetches the tenant's Openprovider password via `secrets/store`, POSTs `/auth/login`, caches the JWT in memory + Postgres, refreshes on expiry, transparently retries once on upstream 401, and dedupes concurrent refreshes (singleflight).

- [ ] **Step 1: Write tests** (unit, with Nock):

  ```ts
  // src/openprovider/token-manager.test.ts
  import { afterEach, describe, expect, it, vi } from 'vitest';
  import nock from 'nock';
  import { createOpenproviderTokenManager } from './token-manager.js';

  describe('openprovider token manager', () => {
    afterEach(() => nock.cleanAll());

    it('logs in on first call and caches the token', async () => {
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .reply(200, { data: { token: 'jwt-1', reseller_id: 42 } });

      const mgr = createOpenproviderTokenManager({
        fetchCredentials: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
        cache: makeMemoryCache(),
      });

      expect(await mgr.getToken('tenant-a')).toBe('jwt-1');
      // Second call hits in-memory cache, no upstream traffic.
      expect(await mgr.getToken('tenant-a')).toBe('jwt-1');
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it('singleflights concurrent refreshes', async () => {
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .reply(200, { data: { token: 'jwt-2', reseller_id: 42 } });

      const mgr = createOpenproviderTokenManager({
        fetchCredentials: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
        cache: makeMemoryCache(),
      });

      const results = await Promise.all([
        mgr.getToken('tenant-x'),
        mgr.getToken('tenant-x'),
        mgr.getToken('tenant-x'),
      ]);
      expect(results).toEqual(['jwt-2', 'jwt-2', 'jwt-2']);
      // Exactly one POST to /auth/login.
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it('refreshes when the cached token is expired', async () => {
      nock('https://api.openprovider.eu')
        .post('/v1beta/auth/login')
        .reply(200, { data: { token: 'jwt-fresh', reseller_id: 42 } });

      const cache = makeMemoryCache();
      cache.set('tenant-z', { token: 'stale', expiresAt: new Date(Date.now() - 1000) });

      const mgr = createOpenproviderTokenManager({
        fetchCredentials: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
        cache,
      });

      expect(await mgr.getToken('tenant-z')).toBe('jwt-fresh');
    });
  });

  function makeMemoryCache() {
    const m = new Map<string, { token: string; expiresAt: Date }>();
    return {
      get: async (t: string) => m.get(t) ?? null,
      set: (t: string, v: { token: string; expiresAt: Date }) => { m.set(t, v); },
      clear: (t: string) => { m.delete(t); },
    };
  }
  ```

- [ ] **Step 2: Write `src/openprovider/token-manager.ts`**

  ```ts
  import { OpenproviderAuthError } from './errors.js';

  export interface TokenCache {
    get(tenantId: string): Promise<{ token: string; expiresAt: Date } | null>;
    set(tenantId: string, value: { token: string; expiresAt: Date }): void | Promise<void>;
    clear(tenantId: string): void | Promise<void>;
  }

  export interface TokenManagerConfig {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    fetchCredentials: (tenantId: string) => Promise<{ username: string; password: string }>;
    cache: TokenCache;
    defaultTtlMs?: number;
  }

  export interface OpenproviderTokenManager {
    getToken(tenantId: string): Promise<string>;
    invalidate(tenantId: string): Promise<void>;
  }

  const DEFAULT_BASE = 'https://api.openprovider.eu/v1beta';
  const DEFAULT_TTL = 12 * 60 * 60 * 1000; // 12h, conservative

  export function createOpenproviderTokenManager(config: TokenManagerConfig): OpenproviderTokenManager {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE;
    const fetcher = config.fetchImpl ?? fetch;
    const inflight = new Map<string, Promise<string>>();

    async function login(tenantId: string): Promise<string> {
      const creds = await config.fetchCredentials(tenantId);
      const res = await fetcher(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: creds.username, password: creds.password }),
      });
      if (res.status === 401) throw new OpenproviderAuthError('invalid Openprovider credentials');
      if (!res.ok) throw new Error(`login failed: ${res.status}`);
      const body = (await res.json()) as { data?: { token?: string } };
      const token = body.data?.token;
      if (!token) throw new Error('login response missing data.token');
      const expiresAt = new Date(Date.now() + (config.defaultTtlMs ?? DEFAULT_TTL));
      await config.cache.set(tenantId, { token, expiresAt });
      return token;
    }

    return {
      async getToken(tenantId) {
        const cached = await config.cache.get(tenantId);
        if (cached && cached.expiresAt.getTime() > Date.now()) return cached.token;
        const existing = inflight.get(tenantId);
        if (existing) return existing;
        const p = login(tenantId).finally(() => inflight.delete(tenantId));
        inflight.set(tenantId, p);
        return p;
      },
      async invalidate(tenantId) {
        await config.cache.clear(tenantId);
      },
    };
  }
  ```

- [ ] **Step 3: Run tests, expect PASS.**

- [ ] **Step 4: Commit**

  ```bash
  git add src/openprovider/token-manager.ts src/openprovider/token-manager.test.ts
  git commit -m "feat(phase2): per-tenant openprovider token manager with singleflight + cache"
  ```

---

## Task 13: Postgres-backed token cache implementation

**Files:**
- Create: `src/openprovider/token-cache-pg.ts`
- Create: `tests/integration/openprovider/token-cache-pg.test.ts`

The Postgres backstop lets multiple replicas share refreshed tokens. Uses the `openprovider_accounts.cached_token` ciphertext column (encrypted via the same envelope mechanism as `tenant_secrets`).

- [ ] **Step 1: Migration `migrations/0006_create_openprovider_accounts.sql`** — adds the table:

  ```sql
  CREATE TABLE openprovider_accounts (
    tenant_id           uuid PRIMARY KEY REFERENCES tenants(id),
    username            text NOT NULL,
    reseller_id         text,
    cached_token        bytea,
    cached_token_nonce  bytea,
    cached_token_tag    bytea,
    token_expires_at    timestamptz,
    status              text NOT NULL DEFAULT 'connected'
                          CHECK (status IN ('connected','invalid_credentials','rate_limited')),
    last_verified_at    timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE openprovider_accounts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE openprovider_accounts FORCE ROW LEVEL SECURITY;
  CREATE POLICY op_accounts_isolation ON openprovider_accounts
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
  GRANT SELECT, INSERT, UPDATE ON openprovider_accounts TO app_role;
  ```

  Append journal entry `{ "idx": 5, "version": "5", "when": 1748000000000, "tag": "0006_create_openprovider_accounts", "breakpoints": true }`.

- [ ] **Step 2: Drizzle schema mirror** in `src/db/schema.ts`:

  ```ts
  export const openproviderAccounts = pgTable('openprovider_accounts', {
    tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
    username: text('username').notNull(),
    resellerId: text('reseller_id'),
    cachedToken: bytea('cached_token'),
    cachedTokenNonce: bytea('cached_token_nonce'),
    cachedTokenTag: bytea('cached_token_tag'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    status: text('status').notNull().default('connected'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).notNull().defaultNow(),
  });
  ```

- [ ] **Step 3: Write `src/openprovider/token-cache-pg.ts`** — implements `TokenCache` with envelope encryption of `cached_token`. The cipher key is the same per-tenant DEK from `secrets/store`, fetched via an injected getter.

  ```ts
  import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
  import type pg from 'pg';
  import type { TokenCache } from './token-manager.js';

  export interface PgTokenCacheDeps {
    client: pg.PoolClient;
    getDek: (tenantId: string) => Promise<Buffer>;
  }

  export function createPgTokenCache(deps: PgTokenCacheDeps): TokenCache {
    return {
      async get(tenantId) {
        const r = await deps.client.query<{
          cached_token: Buffer | null;
          cached_token_nonce: Buffer | null;
          cached_token_tag: Buffer | null;
          token_expires_at: Date | null;
        }>(
          'SELECT cached_token, cached_token_nonce, cached_token_tag, token_expires_at FROM openprovider_accounts WHERE tenant_id = $1',
          [tenantId],
        );
        const row = r.rows[0];
        if (!row?.cached_token || !row.cached_token_nonce || !row.cached_token_tag || !row.token_expires_at) return null;
        const dek = await deps.getDek(tenantId);
        const decipher = createDecipheriv('aes-256-gcm', dek, row.cached_token_nonce);
        decipher.setAuthTag(row.cached_token_tag);
        const tokenBuf = Buffer.concat([decipher.update(row.cached_token), decipher.final()]);
        dek.fill(0);
        return { token: tokenBuf.toString('utf8'), expiresAt: row.token_expires_at };
      },
      async set(tenantId, v) {
        const dek = await deps.getDek(tenantId);
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', dek, nonce);
        const ciphertext = Buffer.concat([cipher.update(v.token, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        dek.fill(0);
        await deps.client.query(
          `UPDATE openprovider_accounts
              SET cached_token = $2,
                  cached_token_nonce = $3,
                  cached_token_tag = $4,
                  token_expires_at = $5,
                  last_verified_at = now()
            WHERE tenant_id = $1`,
          [tenantId, ciphertext, nonce, tag, v.expiresAt],
        );
      },
      async clear(tenantId) {
        await deps.client.query(
          `UPDATE openprovider_accounts SET cached_token = NULL, cached_token_nonce = NULL, cached_token_tag = NULL, token_expires_at = NULL WHERE tenant_id = $1`,
          [tenantId],
        );
      },
    };
  }
  ```

- [ ] **Step 4: Integration test** `tests/integration/openprovider/token-cache-pg.test.ts`:

  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { randomBytes } from 'node:crypto';
  import type pg from 'pg';
  import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
  import { migratedDb, runAsTenant } from '../_helpers/db.js';
  import { createPgTokenCache } from '../../../src/openprovider/token-cache-pg.js';

  const T = '00000000-0000-0000-0000-00000000060a';

  describe('pg token cache integration', () => {
    let fixture: PgFixture;
    let pool: pg.Pool;
    const dek = randomBytes(32);

    beforeAll(async () => {
      fixture = await startPostgres();
      const m = await migratedDb(fixture.url);
      pool = m.pool;
      const c = await pool.connect();
      try {
        await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 't')`, [T]);
        await c.query(
          `INSERT INTO openprovider_accounts (tenant_id, username) VALUES ($1, 'u')`,
          [T],
        );
      } finally {
        c.release();
      }
    }, 60_000);

    afterAll(async () => {
      await pool.end();
      await fixture.stop();
    });

    it('round-trips a cached token under RLS', async () => {
      await runAsTenant(pool, T, async (client) => {
        const cache = createPgTokenCache({
          client,
          getDek: async () => Buffer.from(dek),
        });
        await cache.set(T, { token: 'jwt-abc', expiresAt: new Date(Date.now() + 3600_000) });
        const got = await cache.get(T);
        expect(got?.token).toBe('jwt-abc');
      });
    });
  });
  ```

- [ ] **Step 5: Run all relevant tests**

  ```bash
  npm test -- openprovider
  npm run test:integration -- token-cache-pg
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add migrations/0006_create_openprovider_accounts.sql migrations/meta/_journal.json src/db/schema.ts src/openprovider/token-cache-pg.ts tests/integration/openprovider/token-cache-pg.test.ts
  git commit -m "feat(phase2): postgres-backed openprovider token cache with per-tenant envelope encryption"
  ```

---

## Task 14: Tool dispatch pipeline — `src/mcp/dispatch.ts`

**Files:**
- Create: `src/mcp/dispatch.ts`
- Create: `src/mcp/dispatch.test.ts`

The dispatcher takes a tool invocation + principal, validates args, inserts an `audit_events` row for the invocation, executes the tool, and inserts an audit row for the result (with sanitized payload).

- [ ] **Step 1: Write dispatch tests** with an in-memory audit sink:

  ```ts
  // src/mcp/dispatch.test.ts
  import { describe, expect, it } from 'vitest';
  import { z } from 'zod';
  import { createDispatcher } from './dispatch.js';
  import type { Principal } from '../auth/principal.js';

  const principal: Principal = {
    kind: 'user', tenantId: 't1', userId: 'u1', subject: 's1', scopes: ['mcp:read'], role: 'operator',
  };

  describe('mcp dispatch', () => {
    it('validates args, runs handler, emits two audit rows', async () => {
      const audit: unknown[] = [];
      const dispatch = createDispatcher({
        audit: (row) => { audit.push(row); return Promise.resolve(); },
        tools: [
          {
            name: 'echo',
            description: 'echo',
            inputSchema: z.object({ msg: z.string() }),
            handler: async (args: { msg: string }) => ({ echoed: args.msg }),
          },
        ],
      });

      const result = await dispatch({ name: 'echo', args: { msg: 'hi' }, principal });
      expect(result).toEqual({ echoed: 'hi' });
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({ eventType: 'tool.call', toolName: 'echo' });
      expect(audit[1]).toMatchObject({ eventType: 'tool.result', toolName: 'echo' });
    });

    it('maps validation failure to a structured error with audit row', async () => {
      const audit: unknown[] = [];
      const dispatch = createDispatcher({
        audit: (row) => { audit.push(row); return Promise.resolve(); },
        tools: [
          {
            name: 'echo',
            description: 'echo',
            inputSchema: z.object({ msg: z.string() }),
            handler: async () => ({}),
          },
        ],
      });
      await expect(
        dispatch({ name: 'echo', args: { msg: 123 }, principal }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ eventType: 'tool.error', errorCode: 'validation_failed' });
    });

    it('returns tool_not_found when name is unknown', async () => {
      const dispatch = createDispatcher({
        audit: () => Promise.resolve(),
        tools: [],
      });
      await expect(
        dispatch({ name: 'missing', args: {}, principal }),
      ).rejects.toMatchObject({ code: 'tool_not_found' });
    });
  });
  ```

- [ ] **Step 2: Write `src/mcp/dispatch.ts`**

  ```ts
  import { z, type ZodTypeAny } from 'zod';
  import type { Principal } from '../auth/principal.js';
  import { redactSensitive } from '../observability/redact.js';

  export interface DispatcherTool {
    name: string;
    description: string;
    inputSchema: ZodTypeAny;
    handler: (args: unknown) => Promise<unknown>;
  }

  export interface AuditRow {
    tenantId: string;
    actorKind: 'user' | 'service' | 'system';
    actorSubject: string;
    eventType: 'tool.call' | 'tool.result' | 'tool.error';
    toolName: string;
    requestArgs?: unknown;
    result?: unknown;
    errorCode?: string;
  }

  export interface DispatcherConfig {
    tools: DispatcherTool[];
    audit: (row: AuditRow) => Promise<void>;
  }

  export class DispatchError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'DispatchError';
    }
  }

  export interface DispatchInput {
    name: string;
    args: unknown;
    principal: Principal;
  }

  export function createDispatcher(config: DispatcherConfig) {
    return async (input: DispatchInput): Promise<unknown> => {
      const tool = config.tools.find((t) => t.name === input.name);
      if (!tool) {
        throw new DispatchError('tool_not_found', `tool not found: ${input.name}`);
      }
      let parsed: unknown;
      try {
        parsed = tool.inputSchema.parse(input.args);
      } catch (err) {
        await config.audit({
          tenantId: input.principal.tenantId,
          actorKind: input.principal.kind,
          actorSubject: input.principal.subject,
          eventType: 'tool.error',
          toolName: tool.name,
          requestArgs: redactSensitive(input.args),
          errorCode: 'validation_failed',
        });
        throw new DispatchError('validation_failed', err instanceof z.ZodError ? err.message : String(err));
      }
      await config.audit({
        tenantId: input.principal.tenantId,
        actorKind: input.principal.kind,
        actorSubject: input.principal.subject,
        eventType: 'tool.call',
        toolName: tool.name,
        requestArgs: redactSensitive(parsed),
      });
      try {
        const result = await tool.handler(parsed);
        await config.audit({
          tenantId: input.principal.tenantId,
          actorKind: input.principal.kind,
          actorSubject: input.principal.subject,
          eventType: 'tool.result',
          toolName: tool.name,
          result: redactSensitive(result),
        });
        return result;
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'upstream_error';
        await config.audit({
          tenantId: input.principal.tenantId,
          actorKind: input.principal.kind,
          actorSubject: input.principal.subject,
          eventType: 'tool.error',
          toolName: tool.name,
          errorCode: code,
        });
        throw err;
      }
    };
  }
  ```

- [ ] **Step 3: Run tests, expect PASS.**

- [ ] **Step 4: Commit**

  ```bash
  git add src/mcp/dispatch.ts src/mcp/dispatch.test.ts
  git commit -m "feat(phase2): tool dispatch pipeline with audit-on-every-call + structured errors"
  ```

---

## Task 15: Postgres-backed audit sink

**Files:**
- Create: `src/audit/pg-sink.ts`
- Create: `tests/integration/audit/pg-sink.test.ts`

- [ ] **Step 1: Write `src/audit/pg-sink.ts`**

  ```ts
  import type pg from 'pg';
  import type { AuditRow } from '../mcp/dispatch.js';

  export function createPgAuditSink(getClient: () => Promise<pg.PoolClient>) {
    return async (row: AuditRow): Promise<void> => {
      const client = await getClient();
      try {
        await client.query(
          `INSERT INTO audit_events
             (tenant_id, actor_kind, actor_subject, event_type, tool_name, request_args, result, error_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            row.tenantId,
            row.actorKind,
            row.actorSubject,
            row.eventType,
            row.toolName,
            row.requestArgs ? JSON.stringify(row.requestArgs) : null,
            row.result ? JSON.stringify(row.result) : null,
            row.errorCode ?? null,
          ],
        );
      } finally {
        client.release();
      }
    };
  }
  ```

- [ ] **Step 2: Integration test** asserts audit rows land under RLS:

  ```ts
  // tests/integration/audit/pg-sink.test.ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import type pg from 'pg';
  import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
  import { migratedDb, runAsTenant } from '../_helpers/db.js';
  import { createPgAuditSink } from '../../../src/audit/pg-sink.js';

  const T = '00000000-0000-0000-0000-00000000070a';

  describe('pg audit sink integration', () => {
    let fixture: PgFixture;
    let pool: pg.Pool;

    beforeAll(async () => {
      fixture = await startPostgres();
      const m = await migratedDb(fixture.url);
      pool = m.pool;
      const c = await pool.connect();
      try {
        await c.query(`INSERT INTO tenants (id, name) VALUES ($1, 't')`, [T]);
      } finally { c.release(); }
    }, 60_000);

    afterAll(async () => { await pool.end(); await fixture.stop(); });

    it('inserts an audit row tenant-scoped', async () => {
      await runAsTenant(pool, T, async (client) => {
        const sink = createPgAuditSink(async () => client);
        await sink({
          tenantId: T,
          actorKind: 'user',
          actorSubject: 's',
          eventType: 'tool.call',
          toolName: 'check_domain',
          requestArgs: { domain: 'x.com' },
        });
        const r = await client.query<{ event_type: string }>(`SELECT event_type FROM audit_events`);
        expect(r.rows.map((x) => x.event_type)).toContain('tool.call');
      });
    });
  });
  ```

  > Note: `createPgAuditSink` releases the client after each call. The integration test passes an already-acquired client and stubs `getClient` to return it without releasing back to the pool. Adjust the sink's `client.release()` call in the test by wrapping the client in a no-op release. (Inline this adjustment if needed — the integration test is the authoritative shape.)

- [ ] **Step 3: Run, expect PASS.**

- [ ] **Step 4: Commit**

  ```bash
  git add src/audit/pg-sink.ts tests/integration/audit/pg-sink.test.ts
  git commit -m "feat(phase2): postgres audit sink with RLS-scoped writes"
  ```

---

## Task 16: `check_domain` tool definition

**Files:**
- Create: `src/tools/check-domain.ts`
- Create: `src/tools/check-domain.test.ts`

- [ ] **Step 1: Write `src/tools/check-domain.ts`**

  ```ts
  import { CheckDomainArgs, type CheckDomainResult } from '../openprovider/types.js';
  import type { OpenproviderClient } from '../openprovider/client.js';
  import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';

  export interface CheckDomainDeps {
    client: OpenproviderClient;
    tokenManager: OpenproviderTokenManager;
  }

  export function createCheckDomainTool(deps: CheckDomainDeps) {
    return {
      name: 'check_domain',
      description: 'Check whether domains are available for registration with Openprovider, optionally with prices.',
      inputSchema: CheckDomainArgs,
      handler: async (args: unknown): Promise<CheckDomainResult> => {
        // dispatch already validated, so we just need the tenant context.
        // The tenant id comes from the principal via AsyncLocalStorage in production;
        // for unit tests, we pass it explicitly via a closure.
        throw new Error('tenantId must be supplied via createCheckDomainTool({...tenantContext})');
      },
    };
  }
  ```

  Hmm — the handler needs the tenant id at call time. Two designs:
  - **A:** dispatcher passes `principal` to handlers (extend `DispatcherTool.handler` to `(args, principal) => ...`).
  - **B:** handlers read tenant id from AsyncLocalStorage / request context.

  **Choice:** A. Update `DispatcherTool` and `dispatch.ts` accordingly:

  Modify `src/mcp/dispatch.ts` — `handler: (args: unknown, principal: Principal) => Promise<unknown>` — and call site: `await tool.handler(parsed, input.principal)`.

  Then rewrite `createCheckDomainTool`:

  ```ts
  import { CheckDomainArgs, type CheckDomainResult } from '../openprovider/types.js';
  import type { OpenproviderClient } from '../openprovider/client.js';
  import type { OpenproviderTokenManager } from '../openprovider/token-manager.js';
  import type { Principal } from '../auth/principal.js';

  export interface CheckDomainDeps {
    client: OpenproviderClient;
    tokenManager: OpenproviderTokenManager;
  }

  export function createCheckDomainTool(deps: CheckDomainDeps) {
    return {
      name: 'check_domain',
      description: 'Check whether domains are available for registration.',
      inputSchema: CheckDomainArgs,
      handler: async (args: unknown, principal: Principal): Promise<CheckDomainResult> => {
        const parsed = CheckDomainArgs.parse(args);
        const token = await deps.tokenManager.getToken(principal.tenantId);
        return deps.client.checkDomain(token, parsed);
      },
    };
  }
  ```

  Update `dispatch.test.ts` to pass a principal-aware handler.

- [ ] **Step 2: Write `src/tools/check-domain.test.ts`** — wires fake client + token manager:

  ```ts
  import { describe, expect, it, vi } from 'vitest';
  import { createCheckDomainTool } from './check-domain.js';
  import type { Principal } from '../auth/principal.js';
  import type { CheckDomainResult } from '../openprovider/types.js';

  const principal: Principal = {
    kind: 'user', tenantId: 't1', userId: 'u1', subject: 's1', scopes: ['mcp:read'], role: 'operator',
  };

  describe('check_domain tool', () => {
    it('fetches token then calls client.checkDomain', async () => {
      const fakeResult: CheckDomainResult = { results: [{ domain: 'example.com', status: 'free' }] };
      const client = { checkDomain: vi.fn().mockResolvedValue(fakeResult) };
      const tokenManager = { getToken: vi.fn().mockResolvedValue('jwt'), invalidate: vi.fn() };
      const tool = createCheckDomainTool({ client, tokenManager });

      const result = await tool.handler(
        { domains: [{ name: 'example', extension: 'com' }], with_price: true },
        principal,
      );

      expect(result).toEqual(fakeResult);
      expect(tokenManager.getToken).toHaveBeenCalledWith('t1');
      expect(client.checkDomain).toHaveBeenCalledWith('jwt', expect.objectContaining({
        domains: [{ name: 'example', extension: 'com' }],
      }));
    });
  });
  ```

- [ ] **Step 3: Run, expect PASS.**

- [ ] **Step 4: Commit**

  ```bash
  git add src/tools/check-domain.ts src/tools/check-domain.test.ts src/mcp/dispatch.ts src/mcp/dispatch.test.ts
  git commit -m "feat(phase2): check_domain tool wired through token manager + client"
  ```

---

## Task 17: Wire `check_domain` into the MCP transport

**Files:**
- Modify: `src/mcp/sdk-transport.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Make `sdk-transport.ts` accept a tool list at construction** instead of hard-coding:

  ```ts
  export function createMcpSdkServer(tools: DispatcherTool[]): Server {
    // ... use the passed tools
  }
  ```

  Update both `setRequestHandler(ListToolsRequestSchema, ...)` and `setRequestHandler(CallToolRequestSchema, ...)` to use the parameter.

- [ ] **Step 2: Update `transport.ts`** — accept `tools` in `McpServerConfig`, thread into `createMcpSdkServer`, and into the dispatcher.

- [ ] **Step 3: Update `server.ts`** — build the tool list:

  ```ts
  import { createCheckDomainTool } from './tools/check-domain.js';
  import { createOpenproviderClient } from './openprovider/client.js';
  import { createOpenproviderTokenManager } from './openprovider/token-manager.js';
  // ... fetchCredentials wires the secrets/store
  ```

  > Full wiring of `fetchCredentials` requires a per-tenant `secrets/store` instance, which itself requires a `runAsTenant` connection. This is the most involved wiring step in Phase 2 — the implementer should design it cleanly. The shape:
  >
  > ```ts
  > async function fetchCredentials(tenantId: string) {
  >   const client = await pool.connect();
  >   try {
  >     await client.query('BEGIN');
  >     await client.query('SET LOCAL ROLE app_role');
  >     await client.query('SELECT set_config($1,$2,true)', ['app.current_tenant', tenantId]);
  >     const username = (await client.query<{ username: string }>(
  >       'SELECT username FROM openprovider_accounts WHERE tenant_id = $1', [tenantId],
  >     )).rows[0]?.username;
  >     if (!username) throw new Error(`no openprovider account for tenant ${tenantId}`);
  >     const store = createSecretsStore({ kms, kmsKeyArn: cfg.kmsKeyArn, repo: createDbSecretsRepo(client) });
  >     const passwordBuf = await store.get(tenantId, 'openprovider.password');
  >     if (!passwordBuf) throw new Error(`no openprovider password for tenant ${tenantId}`);
  >     return { username, password: passwordBuf.toString('utf8') };
  >   } finally {
  >     await client.query('COMMIT').catch(() => {});
  >     client.release();
  >   }
  > }
  > ```

- [ ] **Step 4: Build + smoke**

  ```bash
  npm run build
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/mcp/sdk-transport.ts src/mcp/transport.ts src/server.ts
  git commit -m "feat(phase2): wire check_domain into MCP transport via dispatcher"
  ```

---

## Task 18: Per-principal rate limit

**Files:**
- Modify: `src/mcp/transport.ts`
- Create: `src/mcp/rate-limit.test.ts`

- [ ] **Step 1: Add @fastify/rate-limit plugin**:

  ```ts
  import rateLimit from '@fastify/rate-limit';

  // before /mcp route:
  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      // We can't have principal here yet — strip out a coarse key from the bearer.
      const auth = req.headers.authorization ?? 'anon';
      return auth.slice(0, 64);
    },
  });
  ```

  > **Caveat:** ideally the key would be `principal.subject`, but the rate-limit plugin runs before our auth check. A coarse `authorization` header prefix is acceptable for Phase 2; Phase 3 introduces a proper per-principal limiter.

- [ ] **Step 2: Write a test** asserting the 61st request from the same auth header returns 429:

  ```ts
  // src/mcp/rate-limit.test.ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import type { FastifyInstance } from 'fastify';
  import { createMcpServer } from './transport.js';
  import type { Principal } from '../auth/principal.js';

  describe('rate limit', () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await createMcpServer({
        devToken: 'dev',
        devPrincipal: {
          kind: 'user', tenantId: 't', userId: 'u', subject: 'dev', scopes: [], role: 'owner',
        },
      });
      await app.ready();
    });
    afterAll(async () => app.close());

    it('returns 429 after 60 requests within a minute', async () => {
      const headers = { 'content-type': 'application/json', authorization: 'Bearer dev' };
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      for (let i = 0; i < 60; i++) {
        const r = await app.inject({ method: 'POST', url: '/mcp', payload: body, headers });
        expect(r.statusCode).toBeLessThan(429);
      }
      const r = await app.inject({ method: 'POST', url: '/mcp', payload: body, headers });
      expect(r.statusCode).toBe(429);
    });
  });
  ```

- [ ] **Step 3: Run, expect PASS.**

- [ ] **Step 4: Commit**

  ```bash
  git add src/mcp/transport.ts src/mcp/rate-limit.test.ts
  git commit -m "feat(phase2): per-bearer rate limit (60 req/min default)"
  ```

---

## Task 19: End-to-end test — OAuth happy path + cross-tenant isolation

**Files:**
- Create: `tests/integration/mcp/e2e.test.ts`
- Create: `tests/integration/_helpers/fake-jwks.ts`

This is the marquee test of Phase 2: real Fastify server, real Postgres with seeded tenants, real LocalStack KMS, Nock-mocked Openprovider, fake-signed WorkOS JWTs. The test exercises:

1. Tenant A's bearer → `check_domain` for `a.com` → audit row appears in tenant A's slice.
2. Tenant B's bearer → `check_domain` for `b.com` → audit row appears in tenant B's slice; cross-tenant query returns nothing of tenant A.
3. A revoked/wrong-audience bearer → 401.
4. Missing bearer → 401.

Because of the wiring complexity, the implementer should build this incrementally — get scenario 1 green, then add 2, then 3+4. Aim for ~120-second timeout per test.

> Full test code is sketched below but the implementer should adapt to the exact module surface they end up with. The schema and pattern are authoritative; the line-by-line is illustrative.

```ts
// tests/integration/mcp/e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { startPostgres, type PgFixture } from '../_helpers/postgres-container.js';
import { startLocalstackKms, type KmsFixture } from '../_helpers/localstack-kms.js';
import { migratedDb, runAsTenant } from '../_helpers/db.js';
import { createSecretsStore } from '../../../src/secrets/store.js';
import { createAwsKms } from '../../../src/secrets/aws-kms.js';
import { createDbSecretsRepo } from '../../../src/secrets/db-repo.js';

// ... boot everything, mock JWKS at https://api.workos.com/sso/jwks/client_test, mint test tokens.

describe('phase 2 end-to-end', () => {
  // The test pseudo-code from the plan goes here. Each scenario gets its own `it()` block.
});
```

- [ ] **Step 1: Build the helper `tests/integration/_helpers/fake-jwks.ts`** that returns a private key + a static JWKS document and exposes a token-minter.

- [ ] **Step 2: Boot everything in `beforeAll`** (Postgres + LocalStack + Fastify + Nock JWKS interceptor + Openprovider interceptor for `/auth/login` and `/domains/check`).

- [ ] **Step 3: Seed two tenants** (A and B), encrypt their Openprovider passwords into `tenant_secrets`, insert `openprovider_accounts` rows.

- [ ] **Step 4: Write scenarios** 1–4 above as separate `it()` blocks.

- [ ] **Step 5: Run, expect PASS.**

```bash
npm run test:integration -- mcp/e2e
```

- [ ] **Step 6: Commit**

  ```bash
  git add tests/integration/mcp/e2e.test.ts tests/integration/_helpers/fake-jwks.ts
  git commit -m "test(phase2): e2e — OAuth happy path + cross-tenant isolation + 401 paths"
  ```

---

## Task 20: Update CI to run integration tests against testcontainers (already done in Phase 1 — verify)

The Phase 1 CI workflow already runs `npm run test:integration`. Verify it still passes after all the new integration tests above.

- [ ] **Step 1: Push the branch up** (orchestrator handles, pause for user confirmation if not already pushed).

- [ ] **Step 2: Confirm CI is green** on the latest commit.

No new commit required if CI passes.

---

## Task 21: Update README with Phase 2 status

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README** to reflect Phase 2 completion. Change the status section to mention `v0.2.0-phase2`, list the new tool (`check_domain`), and document the WorkOS env vars in the local dev section.

- [ ] **Step 2: Commit**

  ```bash
  git add README.md
  git commit -m "docs(phase2): README update for Phase 2 (WorkOS OAuth + check_domain)"
  ```

---

## Task 22: CHANGELOG + `v0.2.0-phase2` tag (push pause)

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Prepend a new section to `CHANGELOG.md`**:

  ```markdown
  ## [0.2.0-phase2] — TBD

  ### Added
  - WorkOS OAuth bearer-token verification (`@workos-inc/node` + `jose` JWKS cache).
  - `/.well-known/oauth-protected-resource` discovery endpoint.
  - `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` replaces the Phase 1 JSON-RPC shim (Mcp-Session-Id, SSE).
  - Openprovider HTTP client with retry, timeout, opossum circuit breaker, and structured error mapping (`OpenproviderAuthError`, `OpenproviderRateLimitError`, `OpenproviderUnavailableError`, `OpenproviderClientError`).
  - Per-tenant Openprovider token manager with singleflight and Postgres-backed cross-replica cache (envelope-encrypted).
  - `openprovider_accounts` table with RLS and envelope-encrypted cached token columns.
  - Tool dispatch pipeline with `audit_events` writes on every call/result/error.
  - First real tool: `check_domain` (read-only, no policy gate beyond scope check).
  - Per-bearer rate limit (60 req/min default) via `@fastify/rate-limit`.
  - E2E test exercising OAuth happy path + cross-tenant isolation + 401 paths against real Postgres, real LocalStack KMS, Nock-mocked Openprovider and JWKS.

  ### Changed
  - Identity resolver now consumes a `verifier` adapter; the dev token remains as a developer escape hatch but Phase 6's API-key path is still skeletal.
  - Role is provisionally derived from OAuth scopes (`mcp:write` → operator, else viewer) until Phase 6 introduces RBAC stored in the `users` table.

  ### Deferred to later phases
  - List/Get/Update domain + contact tools (Phase 3).
  - Policy engine + confirmations + spend reservations (Phase 4).
  - Write tools + approver workflow (Phase 5).
  - Dashboard (Phase 6).
  ```

  Date stays `TBD` until the user is ready to publish; the tag is created today regardless.

- [ ] **Step 2: Commit + tag**

  ```bash
  git add CHANGELOG.md
  git commit -m "docs(phase2): CHANGELOG for 0.2.0-phase2"
  git tag -a v0.2.0-phase2 -m "Phase 2: First end-to-end vertical slice"
  ```

- [ ] **Step 3: Verify tag is local-only**

  ```bash
  git tag --list 'v0.2*'
  ```

  Expected: `v0.2.0-phase1` AND `v0.2.0-phase2`. **DO NOT PUSH.** Orchestrator handles pushes after user confirmation.

---

## Phase 2 exit checklist

- [ ] WorkOS sandbox project provisioned (Task 1 decision record committed).
- [ ] `npm test && npm run test:integration` all green.
- [ ] Coverage gates: ≥90% on `secrets/store`, `observability/redact`; ≥80% overall (excluding wired-only modules: `server.ts`, `db/**`, `secrets/aws-kms.ts`, `secrets/db-repo.ts`, `secrets/token-cache-pg.ts`, `audit/pg-sink.ts`).
- [ ] E2E test asserts: tenant A and B never see each other's audit rows or `check_domain` results.
- [ ] OAuth happy-path E2E green; invalid-bearer returns 401.
- [ ] Rate-limit test: 61st request from the same bearer returns 429.
- [ ] `check_domain` Nock-mocked end-to-end through MCP transport → dispatch → tool → client → audit.
- [ ] CHANGELOG `0.2.0-phase2` entry + tag created locally.

---

## Self-review

**Spec coverage (Phase 2 in-scope items from the roadmap):**

| Roadmap in-scope item | Task(s) |
|---|---|
| WorkOS OAuth adapter | 4 |
| `.well-known/oauth-protected-resource` | 6 |
| Real OAuth bearer path in `auth/identity` | 5 |
| Streamable HTTP transport (Mcp-Session-Id, SSE) | 7 |
| `mcp/tool-dispatch` validation + audit | 14, 15 |
| `check_domain` wired | 10–13, 16, 17 |
| `openprovider/client` retry + timeout | 10, 11 |
| `audit_events` insert | 15 |
| E2E test (Postgres + LocalStack + Fastify + Nock-driven Openprovider + fake WorkOS) | 19 |
| Per-principal rate limits | 18 |

**Placeholder scan:** Task 17's `fetchCredentials` block is the most prose-y — that's because it's the wiring crossroads between secrets, RLS, and the token manager. No "TBD" / "TODO" anywhere else.

**Type / name consistency:** `Principal`, `AccessTokenVerifier`, `OpenproviderTokenManager`, `OpenproviderClient`, `DispatcherTool`, `AuditRow`, `TokenCache`, `OAuthVerificationError` — all referenced consistently across tasks. `CheckDomainArgs` / `CheckDomainResult` are the single source of truth for the tool's shape.

*End of Phase 2 plan.*
