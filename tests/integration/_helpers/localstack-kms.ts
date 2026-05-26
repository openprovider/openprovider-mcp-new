import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { KMSClient, CreateKeyCommand, CreateAliasCommand } from '@aws-sdk/client-kms';

export interface KmsFixture {
  endpoint: string;
  keyArn: string;
  stop: () => Promise<void>;
}

export async function startLocalstackKms(): Promise<KmsFixture> {
  const c: StartedLocalStackContainer = await new LocalstackContainer('localstack/localstack:3.7')
    .withStartupTimeout(120_000)
    .start();
  const endpoint = c.getConnectionUri();
  const client = new KMSClient({
    region: 'eu-central-1',
    endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const created = await client.send(new CreateKeyCommand({ Description: 'phase1-test' }));
  if (!created.KeyMetadata?.Arn) throw new Error('KMS key creation failed');
  await client.send(
    new CreateAliasCommand({
      AliasName: 'alias/phase1-test',
      TargetKeyId: created.KeyMetadata.KeyId,
    }),
  );
  return {
    endpoint,
    keyArn: created.KeyMetadata.Arn,
    stop: async () => {
      await c.stop();
    },
  };
}
