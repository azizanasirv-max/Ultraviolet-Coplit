/**
 * Encrypted settings store tests (no secret env vars).
 *
 * The encryption key must be generated on disk (0600), settings must survive a
 * process restart, the admin password must live only as a scrypt hash inside the
 * encrypted file, and tampering/malformed keys must fail closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  clearTurnSettingsCache,
  getTurnSettingsStatus,
  loadStoredState,
  loadTurnSettings,
  resolveStorePaths,
  saveAdminPasswordRecord,
  saveTurnSettings,
} from '../server/turnSettingsStore';
import { hashAdminPassword, verifyAdminPassword } from '../server/adminCredentials';

const SECRET = 'store-test-expressturn-secret-value';
const PASSWORD = 'correct-horse-battery-staple';

interface TestEnv {
  dir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

const makeEnv = async (overrides: Record<string, string | undefined> = {}): Promise<TestEnv> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-turn-store-'));
  const env: NodeJS.ProcessEnv = {
    SETTINGS_STORE_PATH: path.join(dir, 'settings.enc'),
    ...overrides,
  };
  return { dir, env, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

const turnInput = (overrides: Record<string, unknown> = {}) => ({
  host: 'turn.expressturn.com',
  port: 3478,
  ttlSeconds: 600,
  secretKey: SECRET,
  ...overrides,
});

test('generates a 0600 encryption key file and encrypts settings without env vars', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    const saved = await saveTurnSettings(turnInput(), env);
    assert.equal(saved.host, 'turn.expressturn.com');
    assert.equal(saved.secretKey, SECRET);

    const paths = resolveStorePaths(env);
    assert.equal(paths.keyFile, path.join(path.dirname(paths.file), 'settings.key'));

    const keyRaw = (await readFile(paths.keyFile, 'utf8')).trim();
    assert.equal(Buffer.from(keyRaw, 'base64').length, 32);
    assert.equal((await stat(paths.keyFile)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.file)).mode & 0o777, 0o600);

    const raw = await readFile(paths.file, 'utf8');
    assert.ok(!raw.includes(SECRET), 'secret is not plaintext on disk');
    assert.ok(!raw.includes('turn.expressturn.com'), 'settings are fully encrypted');
    assert.ok(!raw.includes(keyRaw), 'the key is not embedded in the settings file');

    const status = await getTurnSettingsStatus(env);
    assert.equal(status.storeReady, true);
    assert.equal(status.configured, true);
    assert.equal(status.adminConfigured, false);
    assert.equal(status.keySource, 'key-file');
    assert.ok(!JSON.stringify(status).includes(SECRET));
    assert.ok(!JSON.stringify(status).includes(keyRaw));
  } finally {
    await cleanup();
  }
});

test('settings survive a process restart using only the persisted key file', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    await saveTurnSettings(turnInput(), env);
    clearTurnSettingsCache(); // simulate a restart: no in-memory key/state

    const loaded = await loadTurnSettings(env);
    assert.equal(loaded?.secretKey, SECRET);
    assert.equal(loaded?.port, 3478);
  } finally {
    await cleanup();
  }
});

test('stores the admin password as a scrypt hash only and preserves records on updates', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    const record = await hashAdminPassword(PASSWORD);
    assert.equal(record.hash.length > 0, true);
    await saveAdminPasswordRecord(record, env);

    clearTurnSettingsCache();
    assert.equal(await verifyAdminPassword(PASSWORD, (await loadStoredState(env)).state.admin), true);
    assert.equal(await verifyAdminPassword('wrong-password-123', (await loadStoredState(env)).state.admin), false);

    // Saving TURN settings must keep the admin record.
    await saveTurnSettings(turnInput({ host: 'turn2.expressturn.com' }), env);
    assert.equal(await verifyAdminPassword(PASSWORD, (await loadStoredState(env)).state.admin), true);
    assert.equal((await loadStoredState(env)).state.turn?.host, 'turn2.expressturn.com');

    // Saving the admin record must keep TURN settings.
    await saveAdminPasswordRecord(await hashAdminPassword('a-new-admin-password'), env);
    assert.equal((await loadStoredState(env)).state.turn?.host, 'turn2.expressturn.com');
    assert.equal(await verifyAdminPassword('a-new-admin-password', (await loadStoredState(env)).state.admin), true);
    assert.equal(await verifyAdminPassword(PASSWORD, (await loadStoredState(env)).state.admin), false);

    const raw = await readFile(resolveStorePaths(env).file, 'utf8');
    assert.ok(!raw.includes(PASSWORD));
    assert.ok(!raw.includes(record.hash));
    assert.ok(!raw.includes(record.salt));
  } finally {
    await cleanup();
  }
});

test('fails closed on tampered ciphertext, a wrong key and a malformed key file', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    await saveTurnSettings(turnInput(), env);
    const paths = resolveStorePaths(env);

    // Tamper with the ciphertext.
    const envelope = JSON.parse(await readFile(paths.file, 'utf8')) as { data: string };
    const data = Buffer.from(envelope.data, 'base64');
    data[0] = data[0] ^ 0xff;
    envelope.data = data.toString('base64');
    await writeFile(paths.file, JSON.stringify(envelope));
    clearTurnSettingsCache();
    await assert.rejects(loadTurnSettings(env), /could not be decrypted/);

    // Recovery from a corrupt store is explicit: remove it, then re-save.
    const { rm } = await import('fs/promises');
    await rm(paths.file, { force: true });
    clearTurnSettingsCache();
    await saveTurnSettings(turnInput(), env);
    clearTurnSettingsCache();
    const wrongKey = randomBytes(32).toString('base64');
    await assert.rejects(
      loadTurnSettings({ ...env, SETTINGS_ENCRYPTION_KEY: wrongKey }),
      /could not be decrypted/
    );

    // A malformed key file must not be silently replaced.
    const badKeyFile = 'not-a-key\n';
    await writeFile(paths.keyFile, badKeyFile);
    clearTurnSettingsCache();
    await assert.rejects(loadTurnSettings(env), /encryption key file is malformed/);
    assert.equal(await readFile(paths.keyFile, 'utf8'), badKeyFile);
  } finally {
    await cleanup();
  }
});

test('migrates a legacy turn-only encrypted file and keeps working', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    // Build the exact envelope/plaintext PR #9 wrote (AES-256-GCM, turn only).
    const key = randomBytes(32);
    const paths = resolveStorePaths(env);
    await writeFile(paths.keyFile, `${key.toString('base64')}\n`, { mode: 0o600 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('ultraviolet-copilot/expressturn-settings/v2'));
    const legacy = {
      host: 'turn.expressturn.com',
      port: 3478,
      ttlSeconds: 600,
      secretKey: SECRET,
      updatedAt: 1_800_000_000_000,
    };
    const data = Buffer.concat([cipher.update(JSON.stringify(legacy), 'utf8'), cipher.final()]);
    await writeFile(
      paths.file,
      JSON.stringify({
        v: 2,
        alg: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      })
    );

    const loaded = await loadTurnSettings(env);
    assert.equal(loaded?.secretKey, SECRET);
    assert.equal((await loadStoredState(env)).state.admin, null);

    // The next write upgrades the file to the combined schema and keeps secrets.
    const record = await hashAdminPassword(PASSWORD);
    await saveAdminPasswordRecord(record, env);
    clearTurnSettingsCache();
    assert.equal(await verifyAdminPassword(PASSWORD, (await loadStoredState(env)).state.admin), true);
    assert.equal((await loadStoredState(env)).state.turn?.secretKey, SECRET);
  } finally {
    await cleanup();
  }
});

test('validation, durability reporting and empty-store status', async () => {
  clearTurnSettingsCache();
  const { env, cleanup } = await makeEnv();
  try {
    const empty = await getTurnSettingsStatus(env);
    assert.equal(empty.configured, false);
    assert.equal(empty.adminConfigured, false);
    assert.equal(empty.storeReady, true);
    assert.equal(empty.durable, 'assumed-ephemeral');

    await assert.rejects(
      saveTurnSettings(turnInput({ host: 'https://turn.expressturn.com' }), env),
      /hostname/i
    );
    await assert.rejects(saveTurnSettings(turnInput({ port: 99999 }), env), /port/i);
    await assert.rejects(saveTurnSettings(turnInput({ secretKey: undefined }), env), /secret key is required/i);

    const persistent = await getTurnSettingsStatus({ ...env, SETTINGS_PERSISTENT_STORAGE: 'true' });
    assert.equal(persistent.durable, 'persistent-disk-mounted');
    const ephemeral = await getTurnSettingsStatus({ ...env, SETTINGS_PERSISTENT_STORAGE: 'false' });
    assert.equal(ephemeral.durable, 'assumed-ephemeral');
  } finally {
    await cleanup();
  }
});

