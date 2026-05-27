import argon2 from 'argon2';

export function assertPasswordPolicy(pw: string): void {
  if (typeof pw !== 'string' || pw.length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }
}

export function hashPassword(pw: string): Promise<string> {
  assertPasswordPolicy(pw);
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });
}

export function verifyPassword(hash: string, pw: string): Promise<boolean> {
  return argon2.verify(hash, pw).catch(() => false);
}
