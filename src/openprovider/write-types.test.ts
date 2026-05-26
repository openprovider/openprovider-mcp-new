import { describe, expect, it } from 'vitest';
import {
  RegisterDomainArgs,
  UpdateDomainArgs,
  CreateContactArgs,
  UpdateContactArgs,
} from './types.js';

describe('write arg schemas — strict, no mutation', () => {
  it('accepts a valid register_domain payload', () => {
    const parsed = RegisterDomainArgs.parse({
      domain: { name: 'example', extension: 'com' },
      period: 1,
      owner_handle: 'AB123',
    });
    expect(parsed.period).toBe(1);
  });

  it('rejects register_domain with period 0', () => {
    expect(() =>
      RegisterDomainArgs.parse({
        domain: { name: 'x', extension: 'com' },
        period: 0,
        owner_handle: 'A',
      }),
    ).toThrow();
  });

  it('rejects register_domain without owner_handle', () => {
    expect(() =>
      RegisterDomainArgs.parse({ domain: { name: 'x', extension: 'com' }, period: 1 }),
    ).toThrow();
  });

  it('accepts a valid create_contact and does NOT mutate the phone', () => {
    const parsed = CreateContactArgs.parse({
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+91', subscriber_number: '9876543210' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '110001', country: 'IN' },
    });
    // No India area-code splitting — subscriber_number passes through unchanged.
    expect(parsed.phone.subscriber_number).toBe('9876543210');
    expect(parsed.phone.area_code).toBeUndefined();
  });

  it('rejects create_contact missing last_name', () => {
    expect(() =>
      CreateContactArgs.parse({
        name: { first_name: 'A' },
        phone: { country_code: '+1', subscriber_number: '5551234' },
        address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
      }),
    ).toThrow();
  });

  it('rejects create_contact with a 3-letter country', () => {
    expect(() =>
      CreateContactArgs.parse({
        name: { first_name: 'A', last_name: 'B' },
        phone: { country_code: '+1', subscriber_number: '5551234' },
        address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'USA' },
      }),
    ).toThrow();
  });

  it('does NOT default role or is_active on create_contact', () => {
    const parsed = CreateContactArgs.parse({
      name: { first_name: 'A', last_name: 'B' },
      phone: { country_code: '+1', subscriber_number: '5551234' },
      address: { street: 'S', number: '1', city: 'C', zipcode: '1', country: 'US' },
    });
    expect((parsed as { role?: string }).role).toBeUndefined();
  });

  it('update_contact requires id', () => {
    expect(() => UpdateContactArgs.parse({ email: 'a@b.co' })).toThrow();
    expect(UpdateContactArgs.parse({ id: 7, email: 'a@b.co' }).id).toBe(7);
  });

  it('update_domain requires positive id', () => {
    expect(() => UpdateDomainArgs.parse({ id: 0 })).toThrow();
    expect(UpdateDomainArgs.parse({ id: 5, autorenew: 'on' }).id).toBe(5);
  });
});
