/**
 * Encrypted ExpressTURN settings store tests.
 *
 * These use a temporary directory and real AES-256-GCM files; they assert that
 * the secret never appears in plaintext, that tampering/wrong keys fail closed,
 * and that file permissions are 0600.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import {
  clearTurnSettingsCache,
  getTurnSettingsStatus,
  loadTurnSettings,
  resolveTurnSettingsStoreConfig,
  saveTurnSettings,
} from '../server/turnSettingsStore';

const SECRET = 'store-test-expressturn-secret-value';
const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

interface TestEnv {
  dir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

const makeEnv = async (overrides: Record<string, string | undefined> = {}): Promise<TestEnv> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-turn-store-'));
  const env: NodeJS.ProcessEnv = {
    SETTINGS_ENCRYPTION_KEY: KEY,
    SETTINGS_STORE_PATH: path.join(dir, 'settings.enc'),
    ...overrides,
  };
  return { dir, env, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

test('encrypts settings at rest with AES-256-GCM and mode 0600', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    const saved = await saveTurnSettings(
      { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: SECRET },
      env
    );
    assert.equal(saved.host, 'turn.expressturn.com');
    assert.equal(saved.port, 3478);
    assert.equal(saved.ttlSeconds, 600);
    assert.ok(saved.updatedAt > 0);

    const loaded = await loadTurnSettings(env);
    assert.ok(loaded);
    assert.equal(loaded?.secretKey, SECRET);
    assert.equal(loaded?.host, 'turn.expressturn.com');

    const file = env.SETTINGS_STORE_PATH as string;
    const raw = await readFile(file, 'utf8');
    assert.ok(!raw.includes(SECRET), 'secret must not be plaintext on disk');
    assert.ok(!raw.includes('turn.expressturn.com'), 'settings are fully encrypted');
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(envelope.v, 2);
    assert.equal(envelope.alg, 'aes-256-gcm');
    assert.ok(!('secretKey' in envelope));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await cleanup();
  }
});

test('keeps the existing secret when only host/port/TTL are updated', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    await saveTurnSettings(
      { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: SECRET },
      env
    );
    clearTurnSettingsCache();
    const updated = await saveTurnSettings(
      { host: 'turn2.expressturn.com', port: 3479, ttlSeconds: 900 },
      env
    );
    assert.equal(updated.host, 'turn2.expressturn.com');
    assert.equal(updated.secretKey, SECRET);
    clearTurnSettingsCache();
    assert.equal((await loadTurnSettings(env))?.secretKey, SECRET);
  } finally {
    await cleanup();
  }
});

test('requires a valid 32-byte SETTINGS_ENCRYPTION_KEY and never stores without it', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv({ SETTINGS_ENCRYPTION_KEY: undefined });
  try {
    const config = resolveTurnSettingsStoreConfig(env);
    assert.equal(config.key, null);
    assert.match(config.keyError || '', /SETTINGS_ENCRYPTION_KEY/);
    await assert.rejects(
      saveTurnSettings({ host: 'turn.expressturn.com', port: 3478, secretKey: SECRET }, env),
      /SETTINGS_ENCRYPTION_KEY/
    );
    const status = await getTurnSettingsStatus(env);
    assert.equal(status.storeReady, false);
    assert.equal(status.configured, false);
    assert.ok(!JSON.stringify(status).includes(SECRET));
  } finally {
    await cleanup();
  }
});

test('rejects malformed encryption keys', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv({ SETTINGS_ENCRYPTION_KEY: 'not-a-valid-key' });
  try {
    const status = await getTurnSettingsStatus(env);
    assert.equal(status.storeReady, false);
    assert.match(status.error || '', /32 bytes/);
  } finally {
    await cleanup();
  }
});

test('fails closed on tampered ciphertext and on a wrong encryption key', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    await saveTurnSettings(
      { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: SECRET },
      env
    );
    const file = env.SETTINGS_STORE_PATH as string;

    // Tamper with one byte of ciphertext.
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { data: string };
    const data = Buffer.from(envelope.data, 'base64');
    data[0] = data[0] ^ 0xff;
    envelope.data = data.toString('base64');
    await writeFile(file, JSON.stringify(envelope));
    clearTurnSettingsCache();
    await assert.rejects(loadTurnSettings(env), /could not be decrypted/);

    // Restore a valid file, then try the wrong key.
    await saveTurnSettings(
      { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: SECRET },
      env
    );
    clearTurnSettingsCache();
    const wrongKeyEnv = { ...env, SETTINGS_ENCRYPTION_KEY: OTHER_KEY };
    await assert.rejects(loadTurnSettings(wrongKeyEnv), /could not be decrypted/);

    // The original key still works.
    clearTurnSettingsCache();
    assert.equal((await loadTurnSettings(env))?.secretKey, SECRET);
  } finally {
    await cleanup();
  }
});

test('returns no settings before the first save and reports durability without secrets', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    assert.equal(await loadTurnSettings(env), null);
    const empty = await getTurnSettingsStatus(env);
    assert.equal(empty.configured, false);
    assert.equal(empty.storeReady, true);
    assert.equal(empty.storage, 'encrypted-file');
    assert.equal(empty.encryption, 'aes-256-gcm');
    assert.equal(empty.durable, 'unknown');

    await saveTurnSettings(
      { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: SECRET },
      env
    );
    const configured = await getTurnSettingsStatus(env);
    assert.equal(configured.configured, true);
    assert.equal(configured.host, 'turn.expressturn.com');
    assert.equal(configured.port, 3478);
    assert.ok(!JSON.stringify(configured).includes(SECRET));

    const persistent = await getTurnSettingsStatus({ ...env, SETTINGS_PERSISTENT_STORAGE: 'true' });
    assert.equal(persistent.durable, 'persistent-disk-mounted');
    const ephemeral = await getTurnSettingsStatus({ ...env, SETTINGS_PERSISTENT_STORAGE: 'false' });
    assert.equal(ephemeral.durable, 'assumed-ephemeral');
  } finally {
    await cleanup();
  }
});

test('rejects invalid settings before writing and requires a secret on the first save', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    await assert.rejects(
      saveTurnSettings({ host: 'https://turn.expressturn.com', port: 3478, secretKey: SECRET }, env),
      /hostname/i
    );
    await assert.rejects(
      saveTurnSettings({ host: 'turn.expressturn.com', port: 99999, secretKey: SECRET }, env),
      /port/i
    );
    await assert.rejects(
      saveTurnSettings({ host: 'turn.expressturn.com', port: 3478 }, env),
      /secret key is required/i
    );
    await assert.rejects(
      saveTurnSettings({ host: 'turn.expressturn.com', port: 3478, secretKey: 'short' }, env),
      /between 8 and/i
    );
    assert.equal(await loadTurnSettings(env), null, 'nothing was persisted');
  } finally {
    await cleanup();
  }
});

