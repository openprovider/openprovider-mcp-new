import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDispatcher, DispatchError, type AuditRow } from './dispatch.js';
import type { Principal } from '../auth/principal.js';

const principal: Principal = {
  kind: 'user',
  tenantId: 't1',
  userId: 'u1',
  subject: 's1',
  scopes: ['mcp:read'],
  role: 'operator',
};

describe('mcp dispatch', () => {
  it('validates args, runs handler, emits two audit rows', async () => {
    const audit: AuditRow[] = [];
    const dispatch = createDispatcher({
      audit: (row) => {
        audit.push(row);
        return Promise.resolve();
      },
      tools: [
        {
          name: 'echo',
          description: 'echo',
          inputSchema: z.object({ msg: z.string() }),
          handler: (args, p) =>
            Promise.resolve({ echoed: (args as { msg: string }).msg, tenant: p.tenantId }),
        },
      ],
    });

    const result = await dispatch({ name: 'echo', args: { msg: 'hi' }, principal });
    expect(result).toEqual({ echoed: 'hi', tenant: 't1' });
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ eventType: 'tool.call', toolName: 'echo' });
    expect(audit[1]).toMatchObject({ eventType: 'tool.result', toolName: 'echo' });
  });

  it('maps validation failure to a structured error with audit row', async () => {
    const audit: AuditRow[] = [];
    const dispatch = createDispatcher({
      audit: (row) => {
        audit.push(row);
        return Promise.resolve();
      },
      tools: [
        {
          name: 'echo',
          description: 'echo',
          inputSchema: z.object({ msg: z.string() }),
          handler: () => Promise.resolve({}),
        },
      ],
    });
    await expect(dispatch({ name: 'echo', args: { msg: 123 }, principal })).rejects.toBeInstanceOf(
      DispatchError,
    );
    await expect(dispatch({ name: 'echo', args: { msg: 123 }, principal })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]).toMatchObject({ eventType: 'tool.error', errorCode: 'validation_failed' });
  });

  it('returns tool_not_found when name is unknown', async () => {
    const dispatch = createDispatcher({
      audit: () => Promise.resolve(),
      tools: [],
    });
    await expect(dispatch({ name: 'missing', args: {}, principal })).rejects.toMatchObject({
      code: 'tool_not_found',
    });
  });

  it('emits tool.error audit row when handler throws', async () => {
    const audit: AuditRow[] = [];
    const dispatch = createDispatcher({
      audit: (row) => {
        audit.push(row);
        return Promise.resolve();
      },
      tools: [
        {
          name: 'boom',
          description: 'boom',
          inputSchema: z.object({}),
          handler: () =>
            Promise.reject(
              Object.assign(new Error('upstream gone'), { code: 'openprovider_unavailable' }),
            ),
        },
      ],
    });
    await expect(dispatch({ name: 'boom', args: {}, principal })).rejects.toThrow(/upstream gone/);
    expect(audit.map((a) => a.eventType)).toEqual(['tool.call', 'tool.error']);
    expect(audit[1]).toMatchObject({ errorCode: 'openprovider_unavailable' });
  });

  it('forwards openprovider_not_connected as the audit error code', async () => {
    const audit: AuditRow[] = [];
    const dispatch = createDispatcher({
      audit: (row) => {
        audit.push(row);
        return Promise.resolve();
      },
      tools: [
        {
          name: 'check_domain',
          description: 'x',
          inputSchema: z.object({}),
          handler: () =>
            Promise.reject(
              Object.assign(new Error('not connected'), { code: 'openprovider_not_connected' }),
            ),
        },
      ],
    });
    await expect(dispatch({ name: 'check_domain', args: {}, principal })).rejects.toMatchObject({
      code: 'openprovider_not_connected',
    });
    expect(audit.at(-1)).toMatchObject({
      eventType: 'tool.error',
      errorCode: 'openprovider_not_connected',
    });
  });

  // ── Confirm-mode branch tests ──────────────────────────────────────────────

  it('confirm-mode tool without token returns confirmation_required (proposed)', async () => {
    const audit: AuditRow[] = [];
    const dispatch = createDispatcher({
      audit: (r) => {
        audit.push(r);
        return Promise.resolve();
      },
      tools: [
        {
          name: 'reg',
          description: 'x',
          inputSchema: z.object({ d: z.string() }),
          handler: () => Promise.resolve({ ran: true }),
        },
      ],
      confirm: {
        resolveMode: () => Promise.resolve('confirm'),
        propose: () =>
          Promise.resolve({
            kind: 'proposed',
            result: {
              confirmationId: 'cf1',
              confirmationToken: 'ct1',
              summary: 's',
              estimatedCostEur: 12.99,
              requiredApproverRoles: ['owner'],
              expiresAt: new Date().toISOString(),
            },
          }),
        consume: () => Promise.resolve({ kind: 'ok', confirmationId: 'cf1' }),
        settle: () => Promise.resolve(),
      },
    });
    const r = (await dispatch({ name: 'reg', args: { d: 'a.com' }, principal })) as {
      confirmationToken?: string;
      ran?: boolean;
    };
    expect(r.confirmationToken).toBe('ct1');
    expect(r.ran).toBeUndefined(); // handler NOT executed on propose
  });

  it('confirm-mode tool with token executes the handler after consume', async () => {
    const dispatch = createDispatcher({
      audit: () => Promise.resolve(),
      tools: [
        {
          name: 'reg',
          description: 'x',
          inputSchema: z.object({ d: z.string() }),
          handler: () => Promise.resolve({ ran: true }),
        },
      ],
      confirm: {
        resolveMode: () => Promise.resolve('confirm'),
        propose: () => Promise.resolve({ kind: 'denied', reason: 'should not be called' }),
        consume: () => Promise.resolve({ kind: 'ok', confirmationId: 'cf1' }),
        settle: () => Promise.resolve(),
      },
    });
    const r = (await dispatch({
      name: 'reg',
      args: { d: 'a.com' },
      principal,
      confirm: { token: 'ct1' },
    })) as { ran?: boolean };
    expect(r.ran).toBe(true);
  });

  it('policy_denied propose throws structured error', async () => {
    const dispatch = createDispatcher({
      audit: () => Promise.resolve(),
      tools: [
        {
          name: 'reg',
          description: 'x',
          inputSchema: z.object({ d: z.string() }),
          handler: () => Promise.resolve({}),
        },
      ],
      confirm: {
        resolveMode: () => Promise.resolve('confirm'),
        propose: () => Promise.resolve({ kind: 'denied', reason: 'spend_cap_exceeded' }),
        consume: () => Promise.resolve({ kind: 'ok', confirmationId: 'cf1' }),
        settle: () => Promise.resolve(),
      },
    });
    await expect(dispatch({ name: 'reg', args: { d: 'a.com' }, principal })).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });

  it('settle is called with committed after successful consume+execute', async () => {
    const settle = vi.fn(() => Promise.resolve());
    const dispatch = createDispatcher({
      audit: () => Promise.resolve(),
      tools: [
        {
          name: 'reg',
          description: 'x',
          inputSchema: z.object({ d: z.string() }),
          handler: () => Promise.resolve({ ran: true }),
        },
      ],
      confirm: {
        resolveMode: () => Promise.resolve('confirm'),
        propose: () => Promise.resolve({ kind: 'denied', reason: 'should not be called' }),
        consume: () => Promise.resolve({ kind: 'ok', confirmationId: 'cf1' }),
        settle,
      },
    });
    await dispatch({ name: 'reg', args: { d: 'a.com' }, principal, confirm: { token: 'ct1' } });
    expect(settle).toHaveBeenCalledWith('cf1', 'committed');
  });
});
