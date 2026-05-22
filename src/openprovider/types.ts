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
