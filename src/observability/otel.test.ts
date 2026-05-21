import { describe, expect, it } from 'vitest';
import { startOtel } from './otel.js';

describe('otel', () => {
  it('starts and shuts down without throwing when exporter is unconfigured', async () => {
    const handle = startOtel({ serviceName: 'unit-test' });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
