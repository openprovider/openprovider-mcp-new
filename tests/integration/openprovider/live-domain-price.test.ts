/**
 * Opt-in live-sandbox shape confirmation for getDomainPrice.
 *
 * Skipped unless OPENPROVIDER_LIVE=1 + OPENPROVIDER_SANDBOX_USERNAME/PASSWORD.
 * Calls the Domain Price Service against the sandbox for each of
 * renew/transfer/restore and asserts the parser-assumed shape holds.
 *
 * NON-BILLABLE read endpoint — does not register/renew a domain.
 */
import { describe, expect, it } from 'vitest';
import { createOpenproviderClient } from '../../../src/openprovider/client.js';

const LIVE = process.env.OPENPROVIDER_LIVE === '1';
const d = LIVE ? describe : describe.skip;

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
  if (!res.ok) throw new Error(`Sandbox login failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { token?: string } };
  const token = body.data?.token;
  if (!token) throw new Error('Sandbox login response missing data.token');
  return token;
}

d('live sandbox — getDomainPrice response shape', () => {
  it('returns EUR + numeric price for renew/transfer/restore on .com', async () => {
    const token = await getSandboxToken();
    const client = createOpenproviderClient();
    for (const operation of ['renew', 'transfer', 'restore'] as const) {
      const raw = (await client.getDomainPrice(token, {
        domain: { name: 'example', extension: 'com' },
        operation,
      })) as {
        price?: { product?: { currency?: string; price?: number } };
        is_premium?: boolean;
      };
      expect(raw.price?.product?.currency, `currency for ${operation}`).toBe('EUR');
      expect(typeof raw.price?.product?.price, `price type for ${operation}`).toBe('number');
    }
  }, 30_000);
});
