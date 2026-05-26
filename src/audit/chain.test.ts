import { describe, expect, it } from 'vitest';
import { auditRowCanonical, chainHash, GENESIS } from './chain.js';

const row = {
  id: '1',
  occurredAt: '2026-05-26T00:00:00.000Z',
  tenantId: 't',
  actorKind: 'user',
  actorSubject: 's',
  eventType: 'tool.call',
  toolName: 'check_domain',
  resourceType: null,
  resourceId: null,
  requestArgsText: '{"d": "x.com"}',
  resultText: null,
  httpStatus: null,
  errorCode: null,
  traceId: null,
  spanId: null,
};

describe('audit chain helper', () => {
  it('GENESIS is 32 zero bytes', () => {
    expect(GENESIS).toHaveLength(32);
    expect(GENESIS.every((b) => b === 0)).toBe(true);
  });

  it('canonical joins fields with | and renders nulls as empty', () => {
    const c = auditRowCanonical(row);
    expect(c.startsWith('1|2026-05-26T00:00:00.000Z|t|user|s|tool.call|check_domain|||')).toBe(
      true,
    );
    expect(c).toContain('{"d": "x.com"}'); // request_args verbatim DB ::text
  });

  it('chainHash is deterministic and 32 bytes', () => {
    const h1 = chainHash(GENESIS, auditRowCanonical(row));
    const h2 = chainHash(GENESIS, auditRowCanonical(row));
    expect(h1).toHaveLength(32);
    expect(h1.equals(h2)).toBe(true);
  });

  it('different prev_hash yields different row_hash', () => {
    const a = chainHash(GENESIS, auditRowCanonical(row));
    const b = chainHash(a, auditRowCanonical(row));
    expect(a.equals(b)).toBe(false);
  });
});
