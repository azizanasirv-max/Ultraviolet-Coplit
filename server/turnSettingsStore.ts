/**
 * Encrypted, server-side storage for ExpressTURN settings AND the admin
 * password hash.
 *
 * No secret environment variables are required:
 *   - The AES-256-GCM encryption key is generated on first use and stored as a
 *     0600 `settings.key` file next to the encrypted settings file. An optional
 *     SETTINGS_ENCRYPTION_KEY env var still overrides it (advanced/legacy).
 *   - The admin password is a salted scrypt hash inside the encrypted file.
 *
 * Durability: the store is a local file. It survives deploys/restarts only when
 * the path is on a mounted persistent volume (e.g. a Render persistent disk).
 * Without one, Render's filesystem is ephemeral and everything is lost on
 * redeploy — the admin page and logs report this instead of pretending.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { ExpressTurnServerSettings, validateExpressTurnSettings } from './expressTurn';
import { AdminPasswordRecord, isAdminPasswordRecord } from './adminCredentials';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 2;
const SCHEMA_VERSION = 3;
const AAD = Buffer.from('ultraviolet-copilot/expressturn-settings/v2');
const DEFAULT_RELATIVE_STORE = path.join('data', 'turn-settings.enc');
const RENDER_DISK_DIR = '/var/data';

export type Durability = 'persistent-disk-mounted' | 'assumed-ephemeral';
export type KeySource = 'env' | 'key-file';

export interface StorePaths {
  dir: string;
  file: string;
  keyFile: string;
}

export interface StoreRuntime {
  paths: StorePaths;
  key: Buffer;
  keySource: KeySource;
  durability: Durability;
}

export interface StoredState {
  turn: ExpressTurnServerSettings | null;
  admin: AdminPasswordRecord | null;
}

interface SettingsEnvelope {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  data: string;
}

interface CacheEntry {
  fingerprint: string;
  mtimeMs: number;
  runtime: StoreRuntime | null;
  state: StoredState | null;
  error: Error | null;
}

let cache: CacheEntry | null = null;

/** Test hook: forget the in-process key/state snapshot. */
export const clearTurnSettingsCache = (): void => {
  cache = null;
};

/**
 * Chooses the store location. With no configuration, a mounted Render disk at
 * /var/data is used when present; otherwise ./data (ephemeral on Render).
 */
export const resolveStorePaths = (env: NodeJS.ProcessEnv = process.env): StorePaths => {
  const configured = env.SETTINGS_STORE_PATH?.trim();
  const hasRenderDisk = existsSync(RENDER_DISK_DIR);
  const file =
    configured ||
    (hasRenderDisk ? path.join(RENDER_DISK_DIR, 'uv-admin', 'settings.enc') : path.resolve(DEFAULT_RELATIVE_STORE));
  return {
    dir: path.dirname(file),
    file,
    keyFile: path.join(path.dirname(file), 'settings.key'),
  };
};

const durabilityOf = (file: string, env: NodeJS.ProcessEnv): Durability => {
  if (env.SETTINGS_PERSISTENT_STORAGE === 'true') return 'persistent-disk-mounted';
  if (env.SETTINGS_PERSISTENT_STORAGE === 'false') return 'assumed-ephemeral';
  return file === RENDER_DISK_DIR || file.startsWith(`${RENDER_DISK_DIR}/`)
    ? 'persistent-disk-mounted'
    : 'assumed-ephemeral';
};

const parseKeyMaterial = (raw: string): Buffer | null => {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  const decoded = Buffer.from(value, 'base64');
  const reencoded = decoded.toString('base64').replace(/=+$/, '');
  if (decoded.length === 32 && reencoded === value.replace(/=+$/, '')) return decoded;
  return null;
};

const resolveEncryptionKey = async (
  paths: StorePaths,
  env: NodeJS.ProcessEnv
): Promise<{ key: Buffer; source: KeySource }> => {
  const envKey = env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (envKey) {
    const parsed = parseKeyMaterial(envKey);
    if (!parsed) {
      throw new Error('SETTINGS_ENCRYPTION_KEY must be exactly 32 bytes, encoded as base64 or 64 hex characters.');
    }
    return { key: parsed, source: 'env' };
  }

  let rawKey: string | null = null;
  try {
    rawKey = await fs.readFile(paths.keyFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new Error('The encryption key file could not be read from the settings store directory.');
    }
  }

  if (rawKey !== null) {
    const parsed = parseKeyMaterial(rawKey);
    if (!parsed) {
      // Fail closed: replacing a malformed key would make existing data unreadable.
      throw new Error(
        'The encryption key file is malformed. Restore it from a backup or remove the settings store to start over (this discards saved settings).'
      );
    }
    return { key: parsed, source: 'key-file' };
  }

  await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  await fs.writeFile(paths.keyFile, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(paths.keyFile, 0o600);
  return { key, source: 'key-file' };
};

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

const encryptState = (state: StoredState, key: Buffer): SettingsEnvelope => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, turn: state.turn, admin: state.admin }),
    'utf8'
  );
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
};

const normalizeTurnSettings = (raw: unknown): ExpressTurnServerSettings => {
  const record = (raw ?? {}) as Record<string, unknown>;
  const validation = validateExpressTurnSettings({
    host: record.host,
    port: record.port,
    ttlSeconds: record.ttlSeconds,
    secretKey: record.secretKey,
  });
  if (!validation.ok || !validation.value || !validation.secretKey) {
    throw new Error('stored turn settings failed validation');
  }
  const updatedAt = Number(record.updatedAt);
  return {
    ...validation.value,
    secretKey: validation.secretKey,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : Date.now(),
  };
};

const normalizeState = (payload: unknown): StoredState => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('unsupported schema');
  }
  const record = payload as Record<string, unknown>;

  let turnRaw: unknown = null;
  let adminRaw: unknown = null;
  if (record.schemaVersion === SCHEMA_VERSION) {
    turnRaw = record.turn ?? null;
    adminRaw = record.admin ?? null;
  } else if (typeof record.host === 'string') {
    // Legacy (PR #9) encrypted file: turn settings only, no admin record.
    turnRaw = record;
  } else {
    throw new Error('unsupported schema');
  }

  const turn = turnRaw ? normalizeTurnSettings(turnRaw) : null;
  if (adminRaw !== null && !isAdminPasswordRecord(adminRaw)) {
    throw new Error('stored admin record failed validation');
  }
  return { turn, admin: adminRaw as AdminPasswordRecord | null };
};

const decryptState = (envelope: SettingsEnvelope, key: Buffer): StoredState => {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return normalizeState(JSON.parse(plaintext));
};

const readStateFile = async (
  paths: StorePaths,
  key: Buffer
): Promise<{ state: StoredState; mtimeMs: number }> => {
  let raw: string;
  let mtimeMs = 0;
  try {
    const stat = await fs.stat(paths.file);
    if (!stat.isFile()) throw new Error('settings path is not a file');
    mtimeMs = stat.mtimeMs;
    raw = await fs.readFile(paths.file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { state: { turn: null, admin: null }, mtimeMs: 0 };
    }
    throw new Error('Stored ExpressTURN settings could not be read from SETTINGS_STORE_PATH.');
  }

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
    return { state: decryptState(envelope, key), mtimeMs };
  } catch {
    // Never include ciphertext, key material or secret values in the error.
    throw new Error(
      'Stored ExpressTURN settings could not be decrypted. Restore the matching settings.key (or remove the store to start over).'
    );
  }
};


const fingerprintOf = (paths: StorePaths, env: NodeJS.ProcessEnv): string =>
  `${paths.file}|${env.SETTINGS_ENCRYPTION_KEY?.trim() ? 'env-key' : 'file-key'}`;

/**
 * Resolves the key/store location and decrypts the current state (cached by
 * file mtime). Throws a safe, actionable error when the store is unusable.
 */
export const loadStoredState = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<{ state: StoredState; runtime: StoreRuntime }> => {
  const paths = resolveStorePaths(env);
  const fingerprint = fingerprintOf(paths, env);
  const stat = await fs.stat(paths.file).catch(() => null);
  const mtimeMs = stat ? stat.mtimeMs : 0;

  if (cache && cache.fingerprint === fingerprint && cache.mtimeMs === mtimeMs) {
    if (cache.error) throw cache.error;
    if (cache.runtime && cache.state) return { state: cache.state, runtime: cache.runtime };
  }

  try {
    const resolvedKey = await resolveEncryptionKey(paths, env);
    const runtime: StoreRuntime = {
      paths,
      key: resolvedKey.key,
      keySource: resolvedKey.source,
      durability: durabilityOf(paths.file, env),
    };
    const loaded = await readStateFile(paths, runtime.key);
    cache = {
      fingerprint,
      mtimeMs: loaded.mtimeMs,
      runtime,
      state: loaded.state,
      error: null,
    };
    return { state: loaded.state, runtime };
  } catch (err) {
    const error = err instanceof Error ? err : new Error('Stored settings could not be loaded.');
    cache = { fingerprint, mtimeMs, runtime: null, state: null, error };
    throw error;
  }
};

export const loadTurnSettings = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<ExpressTurnServerSettings | null> => (await loadStoredState(env)).state.turn;

/** Synchronous snapshot used by the ICE endpoint (never throws). */
export const getTurnSettingsSnapshot = (
  env: NodeJS.ProcessEnv = process.env
): { settings: ExpressTurnServerSettings | null; error: Error | null } => {
  if (!cache) return { settings: null, error: null };
  if (cache.fingerprint !== fingerprintOf(resolveStorePaths(env), env)) {
    return { settings: null, error: null };
  }
  return { settings: cache.state?.turn ?? null, error: cache.error };
};


const writeState = async (
  state: StoredState,
  runtime: StoreRuntime,
  env: NodeJS.ProcessEnv
): Promise<void> => {
  const { paths, key } = runtime;
  const envelope = encryptState(state, key);
  const temporary = path.join(
    paths.dir,
    `.${path.basename(paths.file)}.${randomBytes(6).toString('hex')}.tmp`
  );

  try {
    await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, paths.file);
    await fs.chmod(paths.file, 0o600);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new Error('ExpressTURN settings could not be written to the settings store.');
  }

  const stat = await fs.stat(paths.file).catch(() => null);
  cache = {
    fingerprint: fingerprintOf(paths, env),
    mtimeMs: stat ? stat.mtimeMs : 0,
    runtime,
    state,
    error: null,
  };
};

/**
 * Persists the ExpressTURN settings (preserving any stored admin credentials).
 * The secret is encrypted before it touches the disk.
 */
export const saveTurnSettings = async (
  input: { host: unknown; port: unknown; ttlSeconds?: unknown; secretKey?: unknown },
  env: NodeJS.ProcessEnv = process.env
): Promise<ExpressTurnServerSettings> => {
  const { state, runtime } = await loadStoredState(env);
  const existingSecret = state.turn?.secretKey ?? null;
  const requestedSecret =
    typeof input.secretKey === 'string' && input.secretKey.trim().length > 0
      ? input.secretKey
      : existingSecret;

  if (!requestedSecret) throw new Error('A secret key is required for the first save.');

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

  await writeState({ turn: settings, admin: state.admin }, runtime, env);
  return settings;
};

/** Persists the admin password hash (scrypt), preserving TURN settings. */
export const saveAdminPasswordRecord = async (
  record: AdminPasswordRecord,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const { state, runtime } = await loadStoredState(env);
  await writeState({ turn: state.turn, admin: record }, runtime, env);
};

export interface TurnSettingsStatus {
  configured: boolean;
  adminConfigured: boolean;
  storeReady: boolean;
  durable: Durability;
  storage: 'encrypted-file';
  path: string;
  encryption: 'aes-256-gcm';
  keySource: KeySource | null;
  host?: string;
  port?: number;
  ttlSeconds?: number;
  updatedAt?: number;
  error?: string;
}

/** Public admin-page status. Never includes the secret, password or key. */
export const getTurnSettingsStatus = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<TurnSettingsStatus> => {
  const paths = resolveStorePaths(env);
  const base = {
    configured: false,
    adminConfigured: false,
    storeReady: false,
    durable: durabilityOf(paths.file, env),
    storage: 'encrypted-file' as const,
    path: paths.file,
    encryption: 'aes-256-gcm' as const,
    keySource: null,
  };

  try {
    const { state, runtime } = await loadStoredState(env);
    const turn = state.turn;
    return {
      ...base,
      configured: Boolean(turn),
      adminConfigured: Boolean(state.admin),
      storeReady: true,
      durable: durabilityOf(paths.file, env),
      keySource: runtime.keySource,
      ...(turn
        ? { host: turn.host, port: turn.port, ttlSeconds: turn.ttlSeconds, updatedAt: turn.updatedAt }
        : {}),
    };
  } catch (err) {
    return { ...base, error: (err as Error)?.message || 'Stored settings are unavailable.' };
  }
};

