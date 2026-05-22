import { describe, expect, it } from 'vitest';
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
});
