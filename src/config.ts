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
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
