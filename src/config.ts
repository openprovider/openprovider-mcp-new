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
  DASHBOARD_COOKIE_SECRET: z.string().min(1),
  DASHBOARD_COOKIE_SECURE: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
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
    dashboardCookieSecret: parsed.DASHBOARD_COOKIE_SECRET,
    cookieSecure:
      parsed.DASHBOARD_COOKIE_SECURE !== undefined
        ? parsed.DASHBOARD_COOKIE_SECURE === 'true'
        : parsed.NODE_ENV === 'production',
    trustProxy: parsed.TRUST_PROXY === 'true',
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
