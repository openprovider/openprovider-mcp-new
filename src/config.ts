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
  // Local-dev only: swap real GCP KMS for the in-memory fake so the server boots
  // without GCP creds. NEVER set this in production.
  USE_FAKE_KMS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
    useFakeKms: parsed.USE_FAKE_KMS,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
