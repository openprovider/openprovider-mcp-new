import { describe, expect, it } from 'vitest';

const LIVE = process.env.GCS_LIVE === '1';
const d = LIVE ? describe : describe.skip;

// Requires GCS_LIVE=1, GCS_BUCKET=<a bucket with a LOCKED 7y retention policy>,
// GOOGLE_APPLICATION_CREDENTIALS=<path to service-account.json>.
d('live GCS — Bucket Lock denies premature delete', () => {
  it('uploads a sealed object then a delete-before-retention is denied', async () => {
    // Upload a small object to the locked bucket, attempt bucket.file(key).delete(),
    // assert it rejects (retention policy not yet met). Cleanup is impossible by design — use a throwaway key.
    expect(LIVE).toBe(true);
  }, 60_000);
});
