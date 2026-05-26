import { createHash } from 'node:crypto';

export const GENESIS = Buffer.alloc(32, 0);

export interface AuditRowForHash {
  id: string;
  occurredAt: string; // the DB occurred_at::text verbatim
  tenantId: string;
  actorKind: string;
  actorSubject: string;
  eventType: string;
  toolName: string | null;
  resourceType: string | null;
  resourceId: string | null;
  requestArgsText: string | null; // the DB request_args::text verbatim
  resultText: string | null; // the DB result::text verbatim
  httpStatus: string | null; // the DB http_status::text verbatim
  errorCode: string | null;
  traceId: string | null;
  spanId: string | null;
}

export function auditRowCanonical(r: AuditRowForHash): string {
  return [
    r.id,
    r.occurredAt,
    r.tenantId,
    r.actorKind,
    r.actorSubject,
    r.eventType,
    r.toolName ?? '',
    r.resourceType ?? '',
    r.resourceId ?? '',
    r.requestArgsText ?? '',
    r.resultText ?? '',
    r.httpStatus ?? '',
    r.errorCode ?? '',
    r.traceId ?? '',
    r.spanId ?? '',
  ].join('|');
}

export function chainHash(prev: Buffer, canonical: string): Buffer {
  return createHash('sha256').update(prev).update(Buffer.from(canonical, 'utf8')).digest();
}
