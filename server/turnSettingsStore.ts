/**
 * Encrypted, server-side storage for the ExpressTURN settings.
 *
 * Security properties:
 *   - The secret key is encrypted at rest with AES-256-GCM.
 *   - The encryption key comes from SETTINGS_ENCRYPTION_KEY (server env only)
 *     and is never written to disk, returned by an API, or logged.
 *   - The file is written atomically with mode 0600 inside a 0700 directory.
 *   - Reads verify the GCM auth tag, so tampering/wrong keys fail closed.
 *
 * Durability: this is a local file. It survives restarts only when
 * SETTINGS_STORE_PATH points at a mounted persistent volume (e.g. a Render
 * persistent disk). On an ephemeral filesystem the settings are lost on
 * redeploy/restart — see getTurnSettingsStatus().durable.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  ExpressTurnServerSettings,
  validateExpressTurnSettings,
} from './expressTurn';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 2;
const AAD = Buffer.from('ultraviolet-copilot/expressturn-settings/v2');

export interface TurnSettingsStoreConfig {
  path: string;
  key: Buffer | null;
  keyError: string | null;
}

const parseEncryptionKey = (raw: string | undefined): { key: Buffer | null; error: string | null } => {
  const value = raw?.trim();
  if (!value) {
    return {
      key: null,
      error:
        'SETTINGS_ENCRYPTION_KEY is not configured. Add a 32-byte key (base64 or 64-char hex) so the ExpressTURN secret can be stored encrypted.',
    };
  }

  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    const decoded = Buffer.from(value, 'base64');
    // Reject strings that merely decode loosely (Buffer.from is lenient).
    const reencoded = decoded.toString('base64').replace(/=+$/, '');
    if (decoded.length === 32 && reencoded === value.replace(/=+$/, '')) key = decoded;
  }

  if (!key || key.length !== 32) {
    return {
      key: null,
      error:
        'SETTINGS_ENCRYPTION_KEY must be exactly 32 bytes, encoded as base64 (44 chars) or 64 hex characters.',
    };
  }
  return { key, error: null };
};

export const resolveTurnSettingsStoreConfig = (
  env: NodeJS.ProcessEnv = process.env
): TurnSettingsStoreConfig => {
  const parsed = parseEncryptionKey(env.SETTINGS_ENCRYPTION_KEY);
  return {
    path: env.SETTINGS_STORE_PATH?.trim() || path.join(process.cwd(), 'data', 'turn-settings.enc'),
    key: parsed.key,
    keyError: parsed.error,
  };
};

interface CacheEntry {
  fingerprint: string;
  mtimeMs: number;
  settings: ExpressTurnServerSettings | null;
  error: Error | null;
}

let cache: CacheEntry | null = null;

const fingerprintOf = (config: TurnSettingsStoreConfig): string =>
  `${config.path}|${config.key ? createHash('sha256').update(config.key).digest('hex').slice(0, 16) : 'no-key'}`;

/** Test hook: forget the in-process snapshot. */
export const clearTurnSettingsCache = (): void => {
  cache = null;
};

interface SettingsEnvelope {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  data: string;
}

const isEnvelope = (value: unknown): value is SettingsEnvelope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === ENVELOPE_VERSION &&
    record.alg === ALGORITHM &&
    typeof record.iv === 'string' &&
    typeof record.tag === 'string' &&
    typeof record.data === 'string'
  );
};

const encryptSettings = (settings: ExpressTurnServerSettings, key: Buffer): SettingsEnvelope => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(settings), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
};

const decryptSettings = (envelope: SettingsEnvelope, key: Buffer): ExpressTurnServerSettings => {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  const validation = validateExpressTurnSettings({
    host: parsed.host,
    port: parsed.port,
    ttlSeconds: parsed.ttlSeconds,
    secretKey: parsed.secretKey,
  });
  if (!validation.ok || !validation.value || !validation.secretKey) {
    throw new Error('stored settings failed validation');
  }
  const updatedAt = Number(parsed.updatedAt);
  return {
    ...validation.value,
    secretKey: validation.secretKey,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : Date.now(),
  };
};

const readSettingsFile = async (
  config: TurnSettingsStoreConfig
): Promise<{ settings: ExpressTurnServerSettings; mtimeMs: number } | null> => {
  let raw: string;
  let mtimeMs: number;
  try {
    const stat = await fs.stat(config.path);
    if (!stat.isFile()) throw new Error('settings path is not a file');
    mtimeMs = stat.mtimeMs;
    raw = await fs.readFile(config.path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error('Stored ExpressTURN settings could not be read from SETTINGS_STORE_PATH.');
  }

  if (!config.key) throw new Error(config.keyError || 'SETTINGS_ENCRYPTION_KEY is not configured.');

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error('Stored ExpressTURN settings file is malformed.');
  }
  if (!isEnvelope(envelope)) {
    throw new Error('Stored ExpressTURN settings file has an unsupported format.');
  }

  try {
    return { settings: decryptSettings(envelope, config.key), mtimeMs };
  } catch {
    // Never include ciphertext, key material or secret values in the error.
    throw new Error(
      'Stored ExpressTURN settings could not be decrypted. Check SETTINGS_ENCRYPTION_KEY (or re-save the settings from the admin page).'
    );
  }
};

/**
 * Loads (and caches) the encrypted settings. Returns null when nothing has been
 * saved yet. Throws a safe, actionable Error when the key is missing/invalid or
 * the stored file cannot be decrypted.
 */
export const loadTurnSettings = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<ExpressTurnServerSettings | null> => {
  const config = resolveTurnSettingsStoreConfig(env);
  const fingerprint = fingerprintOf(config);

  let mtimeMs = 0;
  try {
    const stat = await fs.stat(config.path).catch(() => null);
    mtimeMs = stat ? stat.mtimeMs : 0;
  } catch {
    mtimeMs = 0;
  }

  if (cache && cache.fingerprint === fingerprint && cache.mtimeMs === mtimeMs) {
    if (cache.error) throw cache.error;
    return cache.settings;
  }

  try {
    const loaded = await readSettingsFile(config);
    cache = {
      fingerprint,
      mtimeMs,
      settings: loaded?.settings ?? null,
      error: null,
    };
    return cache.settings;
  } catch (err) {
    const error = err instanceof Error ? err : new Error('Stored ExpressTURN settings could not be loaded.');
    cache = { fingerprint, mtimeMs, settings: null, error };
    throw error;
  }
};

/** Synchronous snapshot for request-time ICE generation (never throws). */
export const getTurnSettingsSnapshot = (
  env: NodeJS.ProcessEnv = process.env
): { settings: ExpressTurnServerSettings | null; error: Error | null } => {
  const fingerprint = fingerprintOf(resolveTurnSettingsStoreConfig(env));
  if (!cache || cache.fingerprint !== fingerprint) return { settings: null, error: null };
  return { settings: cache.settings, error: cache.error };
};


/**
 * Validates, encrypts and atomically persists the settings. `secretKey` must be
 * supplied for the first save; omitted/empty keeps the existing secret.
 */
export const saveTurnSettings = async (
  input: { host: unknown; port: unknown; ttlSeconds?: unknown; secretKey?: unknown },
  env: NodeJS.ProcessEnv = process.env
): Promise<ExpressTurnServerSettings> => {
  const config = resolveTurnSettingsStoreConfig(env);
  if (!config.key) throw new Error(config.keyError || 'SETTINGS_ENCRYPTION_KEY is not configured.');

  let existingSecret: string | null = null;
  try {
    const current = await loadTurnSettings(env);
    existingSecret = current?.secretKey ?? null;
  } catch {
    // A corrupt stored file must not block an admin from replacing it.
  }

  const requestedSecret =
    typeof input.secretKey === 'string' && input.secretKey.trim().length > 0
      ? input.secretKey
      : existingSecret;

  if (!requestedSecret) {
    throw new Error('A secret key is required for the first save.');
  }

  const validation = validateExpressTurnSettings({
    host: input.host,
    port: input.port,
    ttlSeconds: input.ttlSeconds,
    secretKey: requestedSecret,
  });
  if (!validation.ok || !validation.value || !validation.secretKey) {
    throw new Error(validation.errors.join(' '));
  }

  const settings: ExpressTurnServerSettings = {
    ...validation.value,
    secretKey: validation.secretKey,
    updatedAt: Date.now(),
  };

  const envelope = encryptSettings(settings, config.key);
  const directory = path.dirname(config.path);
  const temporary = path.join(
    directory,
    `.${path.basename(config.path)}.${randomBytes(6).toString('hex')}.tmp`
  );

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, config.path);
    await fs.chmod(config.path, 0o600);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new Error('ExpressTURN settings could not be written to SETTINGS_STORE_PATH.');
  }

  const stat = await fs.stat(config.path).catch(() => null);
  cache = {
    fingerprint: fingerprintOf(config),
    mtimeMs: stat ? stat.mtimeMs : 0,
    settings,
    error: null,
  };
  return settings;
};

export interface TurnSettingsStatus {
  configured: boolean;
  storeReady: boolean;
  durable: 'unknown' | 'persistent-disk-mounted' | 'assumed-ephemeral';
  storage: 'encrypted-file';
  path: string;
  encryption: 'aes-256-gcm';
  host?: string;
  port?: number;
  ttlSeconds?: number;
  updatedAt?: number;
  error?: string;
}

/**
 * Public status for the admin page/API. Never includes the secret key.
 * Durability is reported from SETTINGS_PERSISTENT_STORAGE ("true" when the
 * configured path is a mounted persistent volume).
 */
export const getTurnSettingsStatus = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<TurnSettingsStatus> => {
  const config = resolveTurnSettingsStoreConfig(env);
  const durability =
    env.SETTINGS_PERSISTENT_STORAGE === 'true'
      ? 'persistent-disk-mounted'
      : env.SETTINGS_PERSISTENT_STORAGE === 'false'
        ? 'assumed-ephemeral'
        : 'unknown';

  const base: TurnSettingsStatus = {
    configured: false,
    storeReady: Boolean(config.key),
    durable: durability,
    storage: 'encrypted-file',
    path: config.path,
    encryption: 'aes-256-gcm',
  };

  if (!config.key) return { ...base, error: config.keyError ?? 'SETTINGS_ENCRYPTION_KEY is not configured.' };

  try {
    const settings = await loadTurnSettings(env);
    if (!settings) return base;
    return {
      ...base,
      configured: true,
      host: settings.host,
      port: settings.port,
      ttlSeconds: settings.ttlSeconds,
      updatedAt: settings.updatedAt,
    };
  } catch (err) {
    return { ...base, error: (err as Error)?.message || 'Stored ExpressTURN settings are unavailable.' };
  }
};

