import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerDashboard } from '../../../src/dashboard/server.js';

describe('login rate-limit', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ trustProxy: true });
    await registerDashboard(app, {
      cookieSecret: 'test-secret-32-chars-long-aaaaaa!!',
      cookieSecure: false,
      signup: () => Promise.resolve({ status: 'invalid_password' }),
      login: () => Promise.resolve({ ok: false }),
      registerPages: () => {},
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('allows 5 attempts then 429s the 6th from one IP', async () => {
    const headers = {
      'x-forwarded-for': '203.0.113.7',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const payload = 'email=a@b.c&password=wrong';
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: 'POST', url: '/dashboard/login', headers, payload });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it('a different IP is unaffected', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/dashboard/login',
      headers: {
        'x-forwarded-for': '198.51.100.9',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'email=a@b.c&password=wrong',
    });
    expect(r.statusCode).toBe(401);
  });
});
