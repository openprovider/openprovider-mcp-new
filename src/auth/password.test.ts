import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, assertPasswordPolicy } from './password.js';

describe('password', () => {
  it('hash + verify round-trips and rejects wrong password', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(await verifyPassword(h, 'correct-horse-battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });
  it('assertPasswordPolicy rejects < 12 chars', () => {
    expect(() => assertPasswordPolicy('short')).toThrow();
    expect(assertPasswordPolicy('twelve-chars-ok')).toBeUndefined();
  });
});
