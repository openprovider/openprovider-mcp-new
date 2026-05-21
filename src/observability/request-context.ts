import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  principalSubject?: string;
  principalKind?: 'user' | 'service' | 'system';
}

const als = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}
