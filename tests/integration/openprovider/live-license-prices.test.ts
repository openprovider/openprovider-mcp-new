/**
 * Opt-in live-sandbox shape confirmation for listLicensePrices.
 *
 * Skipped unless OPENPROVIDER_LIVE=1 + OPENPROVIDER_SANDBOX_USERNAME/PASSWORD.
 * NON-BILLABLE read endpoint.
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

d('live sandbox — listLicensePrices response shape', () => {
  it('returns SKU entries with prices[] carrying period + EUR price', async () => {
    const token = await getSandboxToken();
    const client = createOpenproviderClient();
    const raw = (await client.listLicensePrices(token)) as {
      results?: {
        sku?: string;
        prices?: {
          period?: number;
          price?: { product?: { currency?: string; price?: number } };
        }[];
      }[];
    };
    expect(Array.isArray(raw.results)).toBe(true);
    const sample = raw.results?.find(
      (e) => typeof e.sku === 'string' && Array.isArray(e.prices) && e.prices.length > 0,
    );
    expect(sample, 'at least one SKU with prices').toBeTruthy();
    const entry = sample!.prices![0];
    expect(typeof entry.period).toBe('number');
    expect(entry.price?.product?.currency).toBe('EUR');
    expect(typeof entry.price?.product?.price).toBe('number');
  }, 30_000);
});
