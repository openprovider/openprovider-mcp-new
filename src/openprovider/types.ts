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
