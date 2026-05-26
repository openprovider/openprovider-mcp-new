import { sign, unsign } from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import {
  assertCsrf,
  clearSession,
  readSession,
  requireSession,
  setSession,
  type DashboardSession,
} from './session.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers to build minimal Fastify request/reply fakes
// ---------------------------------------------------------------------------

const SECRET = 'test-cookie-secret-32-chars-long!!';
const COOKIE_NAME = 'op_dash';

/** Build a fake FastifyReply that captures setCookie / clearCookie calls. */
function makeFakeReply() {
  const cookies: Record<string, { value: string; opts: Record<string, unknown> }> = {};
  const cleared: string[] = [];

  const reply = {
    setCookie(name: string, value: string, opts: Record<string, unknown>) {
      cookies[name] = { value, opts };
      return reply;
    },
    clearCookie(name: string) {
      cleared.push(name);
      return reply;
    },
    redirect(url: string) {
      (reply as unknown as { _redirect?: string })._redirect = url;
      return reply;
    },
    _cookies: cookies,
    _cleared: cleared,
  } as unknown as FastifyReply & {
    _cookies: typeof cookies;
    _cleared: typeof cleared;
    _redirect?: string;
  };

  return reply;
}

/**
 * Build a fake FastifyRequest that carries a pre-signed op_dash cookie.
 * Mirrors what @fastify/cookie injects at runtime.
 */
function makeFakeReqWithSession(session: DashboardSession | null) {
  const raw =
    session !== null
      ? sign(JSON.stringify(session), SECRET) // produces "value.signature"
      : undefined;

  const cookies: Record<string, string> = {};
  if (raw !== undefined) cookies[COOKIE_NAME] = raw;

  const req = {
    cookies,
    unsignCookie(value: string) {
      return unsign(value, SECRET);
    },
    body: undefined as unknown,
  } as unknown as FastifyRequest;

  return req;
}

// ---------------------------------------------------------------------------
// setSession + readSession round-trip
// ---------------------------------------------------------------------------

describe('setSession / readSession', () => {
  it('round-trips a session through a signed cookie', () => {
    const reply = makeFakeReply();
    const input = { tenantId: 'tid-1', userId: 'uid-1', subject: 'sub-1' };

    const csrf = setSession(reply, input);

    // The cookie must have been set
    const { value: rawValue } = reply._cookies[COOKIE_NAME]!;
    expect(rawValue).toBeTruthy();

    // Simulate what @fastify/cookie does on the next request —
    // the middleware signs the value then stores the signed string in req.cookies.
    // Our fake reply stores the raw (pre-signing) value, so we sign it here.
    const signedValue = sign(rawValue, SECRET);
    const req = {
      cookies: { [COOKIE_NAME]: signedValue },
      unsignCookie: (v: string) => unsign(v, SECRET),
    } as unknown as FastifyRequest;

    const session = readSession(req);
    expect(session).not.toBeNull();
    expect(session!.tenantId).toBe('tid-1');
    expect(session!.userId).toBe('uid-1');
    expect(session!.subject).toBe('sub-1');
    expect(session!.csrf).toBe(csrf);
  });

  it('returns null when the cookie is missing', () => {
    const req = {
      cookies: {},
      unsignCookie: () => ({ valid: false }),
    } as unknown as FastifyRequest;
    expect(readSession(req)).toBeNull();
  });

  it('returns null when the signature is tampered', () => {
    const validSigned = sign(
      JSON.stringify({ tenantId: 't', userId: 'u', subject: 's', csrf: 'x' }),
      SECRET,
    );
    const tampered = validSigned.slice(0, -4) + 'XXXX';
    const req = {
      cookies: { [COOKIE_NAME]: tampered },
      unsignCookie: (v: string) => unsign(v, SECRET),
    } as unknown as FastifyRequest;
    expect(readSession(req)).toBeNull();
  });

  it('returns null when the unsigned value is invalid JSON', () => {
    const badJson = sign('not-json', SECRET);
    const req = {
      cookies: { [COOKIE_NAME]: badJson },
      unsignCookie: (v: string) => unsign(v, SECRET),
    } as unknown as FastifyRequest;
    expect(readSession(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearSession
// ---------------------------------------------------------------------------

describe('clearSession', () => {
  it('clears the op_dash cookie', () => {
    const reply = makeFakeReply();
    clearSession(reply);
    expect(reply._cleared).toContain(COOKIE_NAME);
  });
});

// ---------------------------------------------------------------------------
// requireSession
// ---------------------------------------------------------------------------

describe('requireSession', () => {
  it('calls done() and stashes session when cookie is valid', () => {
    const session: DashboardSession = {
      tenantId: 'tid-2',
      userId: 'uid-2',
      subject: 'sub-2',
      csrf: 'csrf-token',
    };
    const req = makeFakeReqWithSession(session);
    const reply = makeFakeReply();
    const done = vi.fn();

    requireSession(req, reply, done);

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(/* no error */);
    expect((req as FastifyRequest & { session?: DashboardSession }).session).toEqual(session);
  });

  it('redirects to /dashboard/login when no cookie is present', () => {
    const req = {
      cookies: {},
      unsignCookie: () => ({ valid: false }),
    } as unknown as FastifyRequest;
    const reply = makeFakeReply();
    const done = vi.fn();

    requireSession(req, reply, done);

    expect(done).not.toHaveBeenCalled();
    expect((reply as unknown as { _redirect?: string })._redirect).toBe('/dashboard/login');
  });

  it('redirects to /dashboard/login when cookie is tampered', () => {
    const tampered = 'garbage.invalidsig';
    const req = {
      cookies: { [COOKIE_NAME]: tampered },
      unsignCookie: (v: string) => unsign(v, SECRET),
    } as unknown as FastifyRequest;
    const reply = makeFakeReply();
    const done = vi.fn();

    requireSession(req, reply, done);

    expect(done).not.toHaveBeenCalled();
    expect((reply as unknown as { _redirect?: string })._redirect).toBe('/dashboard/login');
  });
});

// ---------------------------------------------------------------------------
// assertCsrf
// ---------------------------------------------------------------------------

describe('assertCsrf', () => {
  it('returns true when body._csrf matches the session csrf', () => {
    const session: DashboardSession = {
      tenantId: 't',
      userId: 'u',
      subject: 's',
      csrf: 'correct-token',
    };
    const req = makeFakeReqWithSession(session);
    (req as unknown as { body: unknown }).body = { _csrf: 'correct-token' };
    expect(assertCsrf(req)).toBe(true);
  });

  it('returns false when body._csrf does not match', () => {
    const session: DashboardSession = {
      tenantId: 't',
      userId: 'u',
      subject: 's',
      csrf: 'correct-token',
    };
    const req = makeFakeReqWithSession(session);
    (req as unknown as { body: unknown }).body = { _csrf: 'wrong-token' };
    expect(assertCsrf(req)).toBe(false);
  });

  it('returns false when no session is present', () => {
    const req = {
      cookies: {},
      unsignCookie: () => ({ valid: false }),
      body: { _csrf: 'anything' },
    } as unknown as FastifyRequest;
    expect(assertCsrf(req)).toBe(false);
  });

  it('returns false when body has no _csrf field', () => {
    const session: DashboardSession = {
      tenantId: 't',
      userId: 'u',
      subject: 's',
      csrf: 'correct-token',
    };
    const req = makeFakeReqWithSession(session);
    (req as unknown as { body: unknown }).body = {};
    expect(assertCsrf(req)).toBe(false);
  });

  it('returns false when body is undefined', () => {
    const session: DashboardSession = {
      tenantId: 't',
      userId: 'u',
      subject: 's',
      csrf: 'token',
    };
    const req = makeFakeReqWithSession(session);
    (req as unknown as { body: unknown }).body = undefined;
    expect(assertCsrf(req)).toBe(false);
  });
});
