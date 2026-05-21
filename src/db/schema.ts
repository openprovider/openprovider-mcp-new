import { customType, pgTable, text, timestamp, uuid, integer, bigserial, jsonb } from 'drizzle-orm/pg-core';


export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

const bytea = customType<{ data: Buffer }>({
  dataType() { return 'bytea'; },
});

export const tenantKeys = pgTable('tenant_keys', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  wrappedDek: bytea('wrapped_dek').notNull(),
  kmsKeyArn: text('kms_key_arn').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});

export const tenantSecrets = pgTable('tenant_secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  authTag: bytea('auth_tag').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});

export const auditEvents = pgTable('audit_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  actorKind: text('actor_kind').notNull(),
  actorSubject: text('actor_subject').notNull(),
  eventType: text('event_type').notNull(),
  toolName: text('tool_name'),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  requestArgs: jsonb('request_args'),
  result: jsonb('result'),
  httpStatus: integer('http_status'),
  errorCode: text('error_code'),
  traceId: text('trace_id'),
  spanId: text('span_id'),
});
