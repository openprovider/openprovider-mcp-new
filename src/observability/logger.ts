import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './request-context.js';
import { REDACTED, REDACTED_PATHS } from './redact.js';

export interface LoggerConfig {
  level?: LoggerOptions['level'];
  destination?: DestinationStream;
}

export function createLogger(config: LoggerConfig = {}): Logger {
  return pino(
    {
      level: config.level ?? process.env['LOG_LEVEL'] ?? 'info',
      formatters: {
        log(obj) {
          const ctx = getRequestContext();
          const enriched: Record<string, unknown> = {
            ...obj,
            ...(ctx?.traceId ? { trace_id: ctx.traceId } : {}),
            ...(ctx?.spanId ? { span_id: ctx.spanId } : {}),
            ...(ctx?.tenantId ? { tenant_id: ctx.tenantId } : {}),
            ...(ctx?.principalSubject ? { principal_subject: ctx.principalSubject } : {}),
            ...(ctx?.principalKind ? { principal_kind: ctx.principalKind } : {}),
          };
          for (const key of Object.keys(enriched)) {
            if (REDACTED_PATHS.has(key)) enriched[key] = REDACTED;
          }
          return enriched;
        },
      },
      redact: { paths: [...REDACTED_PATHS], censor: REDACTED },
    },
    config.destination,
  );
}
