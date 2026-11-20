import { randomBytes, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(deriveKey);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return salt + ':' + key.toString('hex');
}

export async function verifyPassword(password: string, stored?: string) {
  const [salt, key] = (stored ?? ('0'.repeat(32) + ':' + '0'.repeat(128))).split(':');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(derived, Buffer.from(key, 'hex')) && Boolean(stored);
}
