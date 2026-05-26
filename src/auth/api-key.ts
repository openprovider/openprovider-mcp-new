import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const PREFIX_LEN = 12; // 'op_live_' (8) + 4 chars of the random part

export function generateApiKey(): { key: string; prefix: string } {
  const rand = randomBytes(32).toString('base64url');
  const key = `op_live_${rand}`;
  return { key, prefix: key.slice(0, PREFIX_LEN) };
}

export function prefixOf(key: string): string {
  return key.slice(0, PREFIX_LEN);
}

export function hashApiKey(key: string): Promise<string> {
  return argon2.hash(key, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });
}

export function verifyApiKey(hash: string, key: string): Promise<boolean> {
  return argon2.verify(hash, key).catch(() => false);
}
