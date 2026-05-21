export interface Kms {
  generateDataKey(keyArn: string): Promise<{ plaintext: Buffer; ciphertext: Buffer }>;
  decrypt(keyArn: string, ciphertext: Buffer): Promise<Buffer>;
}
