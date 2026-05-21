import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  url: string;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('openprovider_mcp')
    .withUsername('openprovider')
    .withPassword('test')
    .start();
  const url = container.getConnectionUri();
  return {
    container,
    url,
    stop: async () => {
      await container.stop();
    },
  };
}
