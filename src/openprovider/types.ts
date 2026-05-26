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
