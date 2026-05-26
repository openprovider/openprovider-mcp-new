import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, verifyApiKey, prefixOf } from './api-key.js';

describe('api-key helpers', () => {
  it('generates op_live_ keys with a 12-char prefix', () => {
    const { key, prefix } = generateApiKey();
    expect(key.startsWith('op_live_')).toBe(true);
    expect(prefix).toHaveLength(12);
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefixOf(key)).toBe(prefix);
  });

  it('hash + verify round-trips; wrong key fails', async () => {
    const { key } = generateApiKey();
    const hash = await hashApiKey(key);
    expect(await verifyApiKey(hash, key)).toBe(true);
    expect(await verifyApiKey(hash, key + 'x')).toBe(false);
  });
});
