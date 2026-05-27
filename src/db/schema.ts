import {
  customType,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  bigserial,
  bigint,
  jsonb,
  numeric,
} from 'drizzle-orm/pg-core';

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
  dataType() {
    return 'bytea';
  },
});

export const tenantKeys = pgTable('tenant_keys', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  wrappedDek: bytea('wrapped_dek').notNull(),
  kmsKeyArn: text('kms_key_arn').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});

export const tenantSecrets = pgTable('tenant_secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  authTag: bytea('auth_tag').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});

export const openproviderAccounts = pgTable('openprovider_accounts', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  username: text('username').notNull(),
  resellerId: text('reseller_id'),
  cachedToken: bytea('cached_token'),
  cachedTokenNonce: bytea('cached_token_nonce'),
  cachedTokenTag: bytea('cached_token_tag'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  status: text('status').notNull().default('connected'),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable('audit_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
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
  prevHash: bytea('prev_hash'),
  rowHash: bytea('row_hash'),
});

export const policies = pgTable('policies', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  doc: jsonb('doc').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id'),
});

export const confirmations = pgTable('confirmations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  principalSubject: text('principal_subject').notNull(),
  toolName: text('tool_name').notNull(),
  argsHash: bytea('args_hash').notNull(),
  argsJsonb: jsonb('args_jsonb').notNull(),
  summaryText: text('summary_text').notNull(),
  estimatedCostEur: numeric('estimated_cost_eur').notNull().default('0'),
  requiredApproverRoles: text('required_approver_roles').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const idempotencyRecords = pgTable('idempotency_records', {
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  key: text('key').notNull(),
  toolName: text('tool_name').notNull(),
  resultJson: jsonb('result_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const spendReservations = pgTable('spend_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  confirmationId: uuid('confirmation_id').references(() => confirmations.id),
  amountEur: numeric('amount_eur').notNull(),
  status: text('status').notNull().default('pending'),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull(),
  name: text('name').notNull(),
  createdByUserId: uuid('created_by_user_id'),
  scopes: text('scopes').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const auditArchives = pgTable('audit_archives', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  objectUrl: text('object_url').notNull(),
  sha256: text('sha256').notNull(),
  firstId: bigint('first_id', { mode: 'bigint' }).notNull(),
  lastId: bigint('last_id', { mode: 'bigint' }).notNull(),
  lastRowHash: bytea('last_row_hash').notNull(),
  sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  email: text('email').notNull(),
  role: text('role').notNull(),
  token: text('token').notNull(),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
});
