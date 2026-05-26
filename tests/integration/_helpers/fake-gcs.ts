import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Storage } from '@google-cloud/storage';

export interface GcsFixture {
  endpoint: string;
  bucket: string;
  stop: () => Promise<void>;
}

export async function startFakeGcs(bucket = 'op-mcp-test'): Promise<GcsFixture> {
  const container: StartedTestContainer = await new GenericContainer('fsouza/fake-gcs-server:1.49')
    .withCommand(['-scheme', 'http', '-port', '4443', '-public-host', 'localhost:4443'])
    .withExposedPorts(4443)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const mappedPort = container.getMappedPort(4443);
  const host = container.getHost();
  const endpoint = `http://${host}:${mappedPort}`;

  // Create the bucket via the Storage client pointed at fake-gcs.
  // fake-gcs-server accepts the standard GCS JSON API — just override apiEndpoint.
  const storage = new Storage({ projectId: 'test', apiEndpoint: endpoint });
  await storage.createBucket(bucket).catch(() => {
    /* may already exist */
  });

  return {
    endpoint,
    bucket,
    stop: async () => {
      await container.stop();
    },
  };
}
