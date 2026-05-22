import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  AWS_REGION: z.string().default('eu-central-1'),
  AWS_KMS_KEY_ARN: z.string().min(1),
  AWS_ENDPOINT_URL: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  DEV_BEARER_TOKEN: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  WORKOS_CLIENT_ID: z.string().min(1),
  WORKOS_API_KEY: z.string().min(1),
  WORKOS_AUTHKIT_DOMAIN: z.string().url(),
  WORKOS_JWKS_URI: z.string().url(),
  WORKOS_ISSUER: z.string().url().default('https://api.workos.com'),
});

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) {
  const parsed = schema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    awsRegion: parsed.AWS_REGION,
    kmsKeyArn: parsed.AWS_KMS_KEY_ARN,
    awsEndpoint: parsed.AWS_ENDPOINT_URL,
    otlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    devBearerToken: parsed.DEV_BEARER_TOKEN,
    port: parsed.PORT,
    workosClientId: parsed.WORKOS_CLIENT_ID,
    workosApiKey: parsed.WORKOS_API_KEY,
    workosAuthkitDomain: parsed.WORKOS_AUTHKIT_DOMAIN,
    workosJwksUri: parsed.WORKOS_JWKS_URI,
    workosIssuer: parsed.WORKOS_ISSUER,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
