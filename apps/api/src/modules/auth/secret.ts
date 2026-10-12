import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(value: string, secret: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
