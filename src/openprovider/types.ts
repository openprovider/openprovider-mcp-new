import { z } from 'zod';

export const CheckDomainArgs = z.object({
  domains: z
    .array(
      z.object({
        name: z.string().min(1),
        extension: z.string().min(1),
      }),
    )
    .min(1)
    .max(50),
  with_price: z.boolean().default(true),
});
export type CheckDomainArgs = z.infer<typeof CheckDomainArgs>;

export const CheckDomainResult = z.object({
  results: z.array(
    z.object({
      domain: z.string(),
      status: z.string(),
      is_premium: z.boolean().optional(),
      price: z
        .object({
          product: z
            .object({
              price: z.number(),
              currency: z.string(),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
});
export type CheckDomainResult = z.infer<typeof CheckDomainResult>;

export const ListDomainsArgs = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  status: z.string().optional(),
});
export type ListDomainsArgs = z.infer<typeof ListDomainsArgs>;

export const GetDomainArgs = z.object({ id: z.number().int().positive() });
export type GetDomainArgs = z.infer<typeof GetDomainArgs>;

export const ListContactsArgs = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});
export type ListContactsArgs = z.infer<typeof ListContactsArgs>;

export const GetContactArgs = z.object({ id: z.number().int().positive() });
export type GetContactArgs = z.infer<typeof GetContactArgs>;

// Openprovider list/get responses wrap the payload in { data: ... }; we pass the
// inner `data` through as unknown-shaped JSON. The MCP client gets the raw shape;
// strict per-field schemas are deferred until Openprovider publishes an OpenAPI doc.
export const PassthroughResult = z.unknown();
export type PassthroughResult = unknown;

// ---------------------------------------------------------------------------
// Write-arg schemas — strict, no mutation (Phase 5)
// ---------------------------------------------------------------------------

export const RegisterDomainArgs = z.object({
  domain: z.object({ name: z.string().min(1), extension: z.string().min(1) }),
  period: z.number().int().min(1).max(10),
  owner_handle: z.string().min(1),
  admin_handle: z.string().optional(),
  tech_handle: z.string().optional(),
  billing_handle: z.string().optional(),
  name_servers: z
    .array(
      z.object({
        name: z.string().min(1),
        ip: z.string().optional(),
        ip6: z.string().optional(),
      }),
    )
    .optional(),
  ns_group: z.string().optional(),
  is_private_whois_enabled: z.boolean().optional(),
  is_dnssec_enabled: z.boolean().optional(),
  autorenew: z.enum(['on', 'off', 'default']).optional(),
});
export type RegisterDomainArgs = z.infer<typeof RegisterDomainArgs>;

export const UpdateDomainArgs = z.object({
  id: z.number().int().positive(),
  name_servers: z
    .array(
      z.object({ name: z.string().min(1), ip: z.string().optional(), ip6: z.string().optional() }),
    )
    .optional(),
  ns_group: z.string().optional(),
  is_private_whois_enabled: z.boolean().optional(),
  is_dnssec_enabled: z.boolean().optional(),
  autorenew: z.enum(['on', 'off', 'default']).optional(),
});
export type UpdateDomainArgs = z.infer<typeof UpdateDomainArgs>;

const ContactName = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  full_name: z.string().optional(),
  initials: z.string().optional(),
  prefix: z.string().optional(),
});
const ContactPhone = z.object({
  country_code: z.string().min(1),
  subscriber_number: z.string().min(1),
  area_code: z.string().optional(),
});
const ContactAddress = z.object({
  street: z.string().min(1),
  number: z.string().min(1),
  city: z.string().min(1),
  zipcode: z.string().min(1),
  country: z.string().length(2),
  state: z.string().optional(),
  suffix: z.string().optional(),
});

export const CreateContactArgs = z
  .object({
    name: ContactName,
    phone: ContactPhone,
    address: ContactAddress,
    email: z.string().email().optional(),
    company_name: z.string().optional(),
    vat: z.string().optional(),
    gender: z.enum(['M', 'F']).optional(),
    role: z.enum(['admin', 'tech', 'billing', 'owner']).optional(),
  })
  .passthrough();
export type CreateContactArgs = z.infer<typeof CreateContactArgs>;

export const UpdateContactArgs = z
  .object({ id: z.number().int().positive() })
  .merge(CreateContactArgs.partial());
export type UpdateContactArgs = z.infer<typeof UpdateContactArgs>;

// ---------------------------------------------------------------------------
// Domain-lifecycle schemas — batch 1 (Phase enterprise)
// ---------------------------------------------------------------------------

const DomainRef = z.object({ name: z.string().min(1), extension: z.string().min(1) });

export const DomainIdArg = z.object({ id: z.number().int().positive() });
export type DomainIdArg = z.infer<typeof DomainIdArg>;

export const SuggestDomainArgs = z.object({
  name: z.string().min(1),
  tlds: z.array(z.string()).optional(),
  language: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  provider: z.string().optional(),
  sensitive: z.boolean().optional(),
});
export type SuggestDomainArgs = z.infer<typeof SuggestDomainArgs>;

export const ResetAuthcodeArgs = z.object({
  id: z.number().int().positive(),
  domain: DomainRef.optional(),
  auth_code_type: z.enum(['internal', 'registry']).optional(),
  sending_type: z.string().optional(),
});
export type ResetAuthcodeArgs = z.infer<typeof ResetAuthcodeArgs>;

export const ApproveTransferArgs = z.object({
  id: z.number().int().positive(),
  approve: z.union([z.literal(0), z.literal(1)]).optional(),
  auth_code: z.string().optional(),
  domain: DomainRef.optional(),
  registrar_tag: z.string().optional(),
});
export type ApproveTransferArgs = z.infer<typeof ApproveTransferArgs>;

export const RenewDomainArgs = z.object({
  id: z.number().int().positive(),
  period: z.number().int().positive(),
  domain: DomainRef.optional(),
});
export type RenewDomainArgs = z.infer<typeof RenewDomainArgs>;

export const TransferDomainArgs = z.object({
  domain: DomainRef,
  auth_code: z.string().min(1),
  owner_handle: z.string().min(1),
  admin_handle: z.string().optional(),
  tech_handle: z.string().optional(),
  billing_handle: z.string().optional(),
  ns_group: z.string().optional(),
});
export type TransferDomainArgs = z.infer<typeof TransferDomainArgs>;

export const TradeDomainArgs = z.object({
  domain: DomainRef,
  auth_code: z.string().min(1),
  owner_handle: z.string().min(1),
  admin_handle: z.string().optional(),
  tech_handle: z.string().optional(),
  billing_handle: z.string().optional(),
  ns_group: z.string().optional(),
});
export type TradeDomainArgs = z.infer<typeof TradeDomainArgs>;

export const RestoreDomainArgs = z.object({
  id: z.number().int().positive(),
  domain: DomainRef.optional(),
});
export type RestoreDomainArgs = z.infer<typeof RestoreDomainArgs>;

export const RestartDomainOperationArgs = z.object({
  id: z.number().int().positive(),
  auth_code: z.string().optional(),
  domain: DomainRef.optional(),
});
export type RestartDomainOperationArgs = z.infer<typeof RestartDomainOperationArgs>;

// ---------------------------------------------------------------------------
// DNS schemas — batch 2 (Phase enterprise)
// ---------------------------------------------------------------------------

const DnsRecord = z.object({
  name: z.string().optional(),
  type: z.string().min(1),
  value: z.string().min(1),
  ttl: z.number().int().positive(),
  prio: z.number().int().nonnegative().optional(),
});

const DnsTemplateRecord = z.object({
  id: z.number().int().nonnegative().optional(),
  name: z.string().optional(),
  type: z.string().min(1),
  value: z.string().min(1),
  ttl: z.number().int().positive(),
  prio: z.number().int().nonnegative().optional(),
});

const NsGroupMember = z.object({
  id: z.number().int().nonnegative().optional(),
  name: z.string().min(1),
  ip: z.string().min(1),
  ip6: z.string().optional(),
  seq_nr: z.number().int().nonnegative(),
});

// path-only arg schemas
export const ZoneNameArg = z.object({ name: z.string().min(1) });
export type ZoneNameArg = z.infer<typeof ZoneNameArg>;

export const NameserverNameArg = z.object({ name: z.string().min(1) });
export type NameserverNameArg = z.infer<typeof NameserverNameArg>;

export const NsGroupNameArg = z.object({ ns_group: z.string().min(1) });
export type NsGroupNameArg = z.infer<typeof NsGroupNameArg>;

export const TemplateIdArg = z.object({ id: z.number().int().positive() });
export type TemplateIdArg = z.infer<typeof TemplateIdArg>;

export const NoArgs = z.object({});
export type NoArgs = z.infer<typeof NoArgs>;

// zones
export const CreateDnsZoneArgs = z.object({
  domain: DomainRef,
  provider: z.string().min(1),
  type: z.enum(['master', 'slave']),
  master_ip: z.string().optional(),
  secured: z.boolean().optional(),
  template_name: z.string().optional(),
  is_spamexperts_enabled: z.boolean().optional(),
  records: z.array(DnsRecord).optional(),
});
export type CreateDnsZoneArgs = z.infer<typeof CreateDnsZoneArgs>;

export const UpdateDnsZoneArgs = z.object({
  domain: DomainRef,
  provider: z.string().min(1).optional(),
  type: z.enum(['master', 'slave']).optional(),
  master_ip: z.string().optional(),
  secured: z.boolean().optional(),
  dnskey: z.boolean().optional(),
  template_name: z.string().optional(),
  is_spamexperts_enabled: z.boolean().optional(),
  records: z
    .object({
      add: z.array(DnsRecord).optional(),
      remove: z.array(DnsRecord).optional(),
    })
    .optional(),
});
export type UpdateDnsZoneArgs = z.infer<typeof UpdateDnsZoneArgs>;

// nameservers
export const CreateNameserverArgs = z.object({
  name: z.string().min(1),
  ip: z.string().min(1),
  ip6: z.string().optional(),
});
export type CreateNameserverArgs = z.infer<typeof CreateNameserverArgs>;

export const UpdateNameserverArgs = z.object({
  name: z.string().min(1),
  ip: z.string().min(1),
  ip6: z.string().optional(),
});
export type UpdateNameserverArgs = z.infer<typeof UpdateNameserverArgs>;

// ns groups
export const CreateNsGroupArgs = z.object({
  ns_group: z.string().min(1),
  name_servers: z.array(NsGroupMember).min(1),
});
export type CreateNsGroupArgs = z.infer<typeof CreateNsGroupArgs>;

export const UpdateNsGroupArgs = z.object({
  ns_group: z.string().min(1),
  name_servers: z.array(NsGroupMember).min(1),
});
export type UpdateNsGroupArgs = z.infer<typeof UpdateNsGroupArgs>;

// templates
export const CreateDnsTemplateArgs = z.object({
  name: z.string().min(1),
  is_spamexperts_enabled: z.boolean().optional(),
  records: z.array(DnsTemplateRecord).optional(),
});
export type CreateDnsTemplateArgs = z.infer<typeof CreateDnsTemplateArgs>;

// domain token
export const CreateDomainTokenArgs = z.object({
  domain: z.string().min(1),
  zone_provider: z.string().min(1),
});
export type CreateDomainTokenArgs = z.infer<typeof CreateDomainTokenArgs>;

// ---------------------------------------------------------------------------
// Catalog + tag schemas — batch 3 (Phase enterprise)
// ---------------------------------------------------------------------------

export const TldNameArg = z.object({ name: z.string().min(1) });
export type TldNameArg = z.infer<typeof TldNameArg>;

const DomainPriceOperation = z.enum(['create', 'transfer', 'restore', 'renew']);

export const GetDomainPriceArgs = z.object({
  domain: DomainRef,
  operation: DomainPriceOperation,
  additional_data: z
    .object({
      idn_script: z.string().optional(),
    })
    .optional(),
});
export type GetDomainPriceArgs = z.infer<typeof GetDomainPriceArgs>;

export const CreateTagArgs = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});
export type CreateTagArgs = z.infer<typeof CreateTagArgs>;

export const DeleteTagArgs = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});
export type DeleteTagArgs = z.infer<typeof DeleteTagArgs>;

// ---------------------------------------------------------------------------
// SSL schemas — batch 4 (Phase enterprise)
// ---------------------------------------------------------------------------

// Path-id args
export const SslOrderIdArg = z.object({ id: z.number().int().positive() });
export type SslOrderIdArg = z.infer<typeof SslOrderIdArg>;

export const SslProductIdArg = z.object({ id: z.number().int().positive() });
export type SslProductIdArg = z.infer<typeof SslProductIdArg>;

// Query-arg
export const GetSslApproverEmailsArgs = z.object({ domain: z.string().min(1) });
export type GetSslApproverEmailsArgs = z.infer<typeof GetSslApproverEmailsArgs>;

// Shared SSL order body helpers (non-exported)
const DomainValidationMethod = z.object({
  host_name: z.string().min(1),
  method: z.enum(['dns', 'email', 'http']),
});

const SslOrderBody = z.object({
  approver_email: z.string().min(1),
  autorenew: z.enum(['on', 'off']),
  csr: z.string().min(1),
  domain_amount: z.number().int().nonnegative(),
  domain_validation_methods: z.array(DomainValidationMethod).min(1),
  enable_dns_automation: z.boolean(),
  host_names: z.array(z.string().min(1)).min(1),
  organization_handle: z.string().min(1),
  period: z.number().int().positive(),
  product_id: z.number().int().positive(),
  signature_hash_algorithm: z.string().min(1),
  software_id: z.string().min(1),
  start_provision: z.boolean(),
  technical_handle: z.string().min(1),
  wildcard_domain_amount: z.number().int().nonnegative(),
});

export const CreateSslOrderArgs = SslOrderBody;
export type CreateSslOrderArgs = z.infer<typeof CreateSslOrderArgs>;

export const UpdateSslOrderArgs = SslOrderBody.extend({ id: z.number().int().positive() });
export type UpdateSslOrderArgs = z.infer<typeof UpdateSslOrderArgs>;

export const ReissueSslOrderArgs = SslOrderBody.extend({ id: z.number().int().positive() });
export type ReissueSslOrderArgs = z.infer<typeof ReissueSslOrderArgs>;

// Renew / Cancel
export const RenewSslOrderArgs = z.object({
  id: z.number().int().positive(),
  enable_dns_automation: z.boolean(),
});
export type RenewSslOrderArgs = z.infer<typeof RenewSslOrderArgs>;

export const CancelSslOrderArgs = z.object({ id: z.number().int().positive() });
export type CancelSslOrderArgs = z.infer<typeof CancelSslOrderArgs>;

// Approver-email actions
export const UpdateSslApproverEmailArgs = z.object({
  id: z.number().int().positive(),
  approver_email: z.string().min(1),
});
export type UpdateSslApproverEmailArgs = z.infer<typeof UpdateSslApproverEmailArgs>;

export const ResendSslApproverEmailArgs = z.object({ id: z.number().int().positive() });
export type ResendSslApproverEmailArgs = z.infer<typeof ResendSslApproverEmailArgs>;

// CSR
export const CreateCsrArgs = z.object({
  bits: z.number().int().positive(),
  common_name: z.string().min(1),
  country: z.string().min(2).max(2),
  email: z.string().min(1),
  locality: z.string().min(1),
  organization: z.string().min(1),
  signature_hash_algorithm: z.string().min(1),
  state: z.string().min(1),
  subject_alternative_name: z.array(z.string()).optional(),
  unit: z.string().optional(),
  with_config: z.boolean().optional(),
});
export type CreateCsrArgs = z.infer<typeof CreateCsrArgs>;

export const DecodeCsrArgs = z.object({ csr: z.string().min(1) });
export type DecodeCsrArgs = z.infer<typeof DecodeCsrArgs>;

// OTP token
export const CreateSslOtpTokenArgs = z.object({ id: z.number().int().positive() });
export type CreateSslOtpTokenArgs = z.infer<typeof CreateSslOtpTokenArgs>;

// ---------------------------------------------------------------------------
// Customer schemas — batch 5 (Phase enterprise)
// ---------------------------------------------------------------------------

const CustomerName = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  full_name: z.string().optional(),
  initials: z.string().optional(),
  prefix: z.string().optional(),
});
const CustomerAddress = z.object({
  street: z.string().min(1),
  number: z.string().min(1),
  city: z.string().min(1),
  zipcode: z.string().min(1),
  state: z.string().optional(),
  country: z.string().min(2).max(2),
  suffix: z.string().optional(),
});
const CustomerPhone = z.object({
  country_code: z.string().min(1),
  area_code: z.string().min(1),
  subscriber_number: z.string().min(1),
});
const CustomerFax = z.object({
  country_code: z.string().optional(),
  area_code: z.string().optional(),
  subscriber_number: z.string().optional(),
});
const CustomerTag = z.object({ key: z.string(), value: z.string() });
const ExtensionAdditionalData = z.object({
  name: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export const CustomerHandleArg = z.object({ handle: z.string().min(1) });
export type CustomerHandleArg = z.infer<typeof CustomerHandleArg>;

export const CreateCustomerArgs = z.object({
  email: z.string().min(1),
  username: z.string().min(1),
  name: CustomerName,
  address: CustomerAddress,
  phone: CustomerPhone,
  fax: CustomerFax.optional(),
  tags: z.array(CustomerTag).optional(),
  company_name: z.string().optional(),
  comments: z.string().optional(),
  locale: z.string().optional(),
  vat: z.string().optional(),
  additional_data: z.record(z.string(), z.unknown()).optional(),
  extension_additional_data: z.array(ExtensionAdditionalData).optional(),
});
export type CreateCustomerArgs = z.infer<typeof CreateCustomerArgs>;

// Update: handle (path) + partial body (everything else optional; username NOT updatable)
export const UpdateCustomerArgs = z.object({
  handle: z.string().min(1),
  email: z.string().min(1).optional(),
  name: CustomerName.partial().optional(),
  address: CustomerAddress.partial().optional(),
  phone: CustomerPhone.partial().optional(),
  fax: CustomerFax.optional(),
  tags: z.array(CustomerTag).optional(),
  company_name: z.string().optional(),
  comments: z.string().optional(),
  locale: z.string().optional(),
  vat: z.string().optional(),
  additional_data: z.record(z.string(), z.unknown()).optional(),
  extension_additional_data: z.array(ExtensionAdditionalData).optional(),
});
export type UpdateCustomerArgs = z.infer<typeof UpdateCustomerArgs>;
