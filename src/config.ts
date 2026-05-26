import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  GCP_PROJECT_ID: z.string().min(1),
  GCP_KMS_KEY_NAME: z.string().min(1),
  GCS_BUCKET: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  DEV_BEARER_TOKEN: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  WORKOS_CLIENT_ID: z.string().min(1),
  WORKOS_API_KEY: z.string().min(1),
  WORKOS_AUTHKIT_DOMAIN: z.string().url(),
  WORKOS_JWKS_URI: z.string().url(),
  // No default: for an MCP server the issuer is the AuthKit domain, which is
  // environment-specific. A default would silently mismatch real tokens.
  WORKOS_ISSUER: z.string().url(),
  DASHBOARD_COOKIE_SECRET: z.string().min(1),
});

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) {
  const parsed = schema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    gcpProjectId: parsed.GCP_PROJECT_ID,
    gcpKmsKeyName: parsed.GCP_KMS_KEY_NAME,
    gcsBucket: parsed.GCS_BUCKET,
    otlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    devBearerToken: parsed.DEV_BEARER_TOKEN,
    port: parsed.PORT,
    workosClientId: parsed.WORKOS_CLIENT_ID,
    workosApiKey: parsed.WORKOS_API_KEY,
    workosAuthkitDomain: parsed.WORKOS_AUTHKIT_DOMAIN,
    workosJwksUri: parsed.WORKOS_JWKS_URI,
    workosIssuer: parsed.WORKOS_ISSUER,
    dashboardCookieSecret: parsed.DASHBOARD_COOKIE_SECRET,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
