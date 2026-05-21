import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface OtelHandle {
  shutdown: () => Promise<void>;
}

export function startOtel(opts: { serviceName: string; exporterUrl?: string }): OtelHandle {
  const sdk = new NodeSDK({
    resource: new Resource({ [ATTR_SERVICE_NAME]: opts.serviceName }),
    ...(opts.exporterUrl ? { traceExporter: new OTLPTraceExporter({ url: opts.exporterUrl }) } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}
