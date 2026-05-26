import { describe, expect, it } from 'vitest';
import { eurToCents, centsToEur, parseEurString } from './money.js';

describe('money', () => {
  it('eurToCents rounds to nearest cent', () => {
    expect(eurToCents(12.99)).toBe(1299);
    expect(eurToCents(0)).toBe(0);
    expect(eurToCents(9.005)).toBe(901); // round half up at cent
  });
  it('centsToEur returns a 2-decimal number', () => {
    expect(centsToEur(1299)).toBe(12.99);
    expect(centsToEur(0)).toBe(0);
  });
  it('parseEurString parses pg numeric strings to cents', () => {
    expect(parseEurString('12.9900')).toBe(1299);
    expect(parseEurString('0')).toBe(0);
    expect(parseEurString(null)).toBe(0);
  });
});
