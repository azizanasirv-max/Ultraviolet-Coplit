/**
 * Admin password hashing/verification (scrypt) for the ExpressTURN admin page.
 *
 * The password is never stored, logged, returned, or placed in an environment
 * variable. Only a salted scrypt hash lives inside the encrypted settings file.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 256;

const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;

export interface AdminPasswordRecord {
  salt: string;
  hash: string;
  updatedAt: number;
}

export const validateAdminPassword = (password: unknown): string[] => {
  if (typeof password !== 'string') return ['Password must be a string.'];
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    return [`Password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`];
  }
  if (password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    return [`Password must be at most ${ADMIN_PASSWORD_MAX_LENGTH} characters.`];
  }
  return [];
};

export const hashAdminPassword = async (
  password: string,
  now = Date.now()
): Promise<AdminPasswordRecord> => {
  if (validateAdminPassword(password).length > 0) {
    throw new Error(`Password must be between ${ADMIN_PASSWORD_MIN_LENGTH} and ${ADMIN_PASSWORD_MAX_LENGTH} characters.`);
  }
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
  return { salt: salt.toString('base64'), hash: derived.toString('base64'), updatedAt: now };
};

export const verifyAdminPassword = async (
  password: unknown,
  record: AdminPasswordRecord | null | undefined
): Promise<boolean> => {
  if (!record || typeof password !== 'string' || password.length === 0) return false;
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const derived = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
};

export const isAdminPasswordRecord = (value: unknown): value is AdminPasswordRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.salt === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  );
};
