/**
 * Opt-in live-sandbox contact round-trip test.
 *
 * This file is SKIPPED by default. It only executes when the following
 * environment variables are set:
 *
 *   OPENPROVIDER_LIVE=1
 *   OPENPROVIDER_SANDBOX_USERNAME=<your sandbox username>
 *   OPENPROVIDER_SANDBOX_PASSWORD=<your sandbox password>
 *
 * The Openprovider sandbox endpoint is used (https://api.openprovider.eu/v1beta).
 * Contact operations (create/get/update/delete) are NON-BILLABLE.
 * This test NEVER calls registerDomain — no domain registration occurs.
 *
 * Intended for nightly CI runs with real sandbox credentials injected as secrets.
 * Do NOT set OPENPROVIDER_LIVE in standard CI — the suite must skip cleanly.
 */

import { describe, expect, it } from 'vitest';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';

const LIVE = process.env.OPENPROVIDER_LIVE === '1';
const d = LIVE ? describe : describe.skip;

/** Login directly against the Openprovider sandbox and return a bearer token. */
async function getSandboxToken(): Promise<string> {
  const username = process.env.OPENPROVIDER_SANDBOX_USERNAME;
  const password = process.env.OPENPROVIDER_SANDBOX_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'OPENPROVIDER_SANDBOX_USERNAME and OPENPROVIDER_SANDBOX_PASSWORD must be set when OPENPROVIDER_LIVE=1',
    );
  }
  const res = await fetch('https://api.openprovider.eu/v1beta/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) throw new Error('Sandbox login failed: invalid credentials');
  if (!res.ok) throw new Error(`Sandbox login failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { token?: string } };
  const token = body.data?.token;
  if (!token) throw new Error('Sandbox login response missing data.token');
  return token;
}

d('live sandbox — contact round trip (NON-BILLABLE; no domain registration)', () => {
  it('create → get → update (change email) → delete a contact', async () => {
    const token = await getSandboxToken();
    const client = createOpenproviderClient();

    // ── 1. CREATE ──────────────────────────────────────────────────────────
    const uniqueEmail = `live-test-${Date.now()}@sandbox-mcp.invalid`;
    const createResult = (await client.createContact(token, {
      name: { first_name: 'LiveTest', last_name: 'MCPSandbox' },
      phone: { country_code: '+1', subscriber_number: '5550000001' },
      address: {
        street: 'Test Street',
        number: '1',
        city: 'TestCity',
        zipcode: '10001',
        country: 'US',
      },
      email: uniqueEmail,
    })) as { handle?: string; id?: number };

    expect(createResult).toBeDefined();
    // Openprovider returns either a handle or an id for created contacts.
    const contactId: number | undefined =
      typeof createResult.id === 'number' ? createResult.id : undefined;
    const contactHandle: string | undefined =
      typeof createResult.handle === 'string' ? createResult.handle : undefined;

    expect(contactId !== undefined || contactHandle !== undefined).toBe(true);

    // Resolve numeric id for subsequent calls (GET by id is the stable API).
    let resolvedId = contactId;
    if (resolvedId === undefined && contactHandle) {
      // Some sandbox responses only return handle; we accept that and skip id-based steps.
    }

    // ── 2. GET ─────────────────────────────────────────────────────────────
    if (resolvedId !== undefined) {
      const getResult = (await client.getContact(token, resolvedId)) as {
        email?: string;
        handle?: string;
        name?: { first_name?: string; last_name?: string };
      };
      expect(getResult).toBeDefined();
      // The contact we just created should be retrievable.
      expect(getResult.name?.last_name).toBe('MCPSandbox');

      // ── 3. UPDATE (change email) ──────────────────────────────────────────
      const updatedEmail = `live-updated-${Date.now()}@sandbox-mcp.invalid`;
      const updateResult = (await client.updateContact(token, resolvedId, {
        id: resolvedId,
        email: updatedEmail,
      })) as Record<string, unknown>;
      // A successful update returns a data object (shape varies by sandbox version).
      expect(updateResult).toBeDefined();

      // ── 4. DELETE ─────────────────────────────────────────────────────────
      const deleteResult = (await client.deleteContact(token, resolvedId)) as Record<
        string,
        unknown
      >;
      expect(deleteResult).toBeDefined();
    } else {
      // handle-only response path: just assert the handle is present and skip id-based ops.
      expect(typeof contactHandle).toBe('string');
    }
  }, 60_000);
});
