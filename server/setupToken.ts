/**
 * One-time bootstrap token for the very first admin password.
 *
 * A secure first-admin flow needs one out-of-band secret: there is no way to
 * authenticate the first operator over the public internet without it. To avoid
 * requiring an environment variable, the app generates a token and writes it to
 * a 0600 file on the persistent volume. The operator reads that file through
 * Render's Shell/SSH (or any disk access), enters it once, and the file is
 * deleted. The token never appears in logs, HTTP responses, page HTML, or Git.
 *
 * Optional overrides for environments without shell access:
 *   ADMIN_SETUP_TOKEN_FILE=/etc/secrets/admin-setup-token  (Render secret file)
 *   ADMIN_SETUP_TOKEN=<token>                              (env var)
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export const SETUP_TOKEN_MIN_LENGTH = 16;
export const DEFAULT_SETUP_TOKEN_FILENAME = 'admin-setup-token';

export type SetupTokenSource = 'env' | 'file' | 'generated';

export interface SetupTokenInfo {
  /** A token is available for the first-run setup form. */
  available: boolean;
  /** Path on the server filesystem; never the token itself. */
  path: string;
  source: SetupTokenSource;
  /** True when this process created the file (safe to delete after setup). */
  generated: boolean;
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

const readTokenFile = async (filePath: string): Promise<string | null> => {
  try {
    const token = (await fs.readFile(filePath, 'utf8')).trim();
    return token.length >= SETUP_TOKEN_MIN_LENGTH ? token : null;
  } catch {
    return null;
  }
};

/**
 * Returns the current bootstrap-token location, creating a token file on first
 * use when no explicit token source is configured.
 */
export const ensureSetupToken = async (
  storeDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<SetupTokenInfo> => {
  const envToken = env.ADMIN_SETUP_TOKEN?.trim();
  if (envToken && envToken.length >= SETUP_TOKEN_MIN_LENGTH) {
    return { available: true, path: '(ADMIN_SETUP_TOKEN)', source: 'env', generated: false };
  }

  const explicitPath = env.ADMIN_SETUP_TOKEN_FILE?.trim();
  if (explicitPath) {
    const token = await readTokenFile(explicitPath);
    return { available: Boolean(token), path: explicitPath, source: 'file', generated: false };
  }

  const generatedPath = path.join(storeDir, DEFAULT_SETUP_TOKEN_FILENAME);
  const existing = await readTokenFile(generatedPath);
  if (existing) {
    return { available: true, path: generatedPath, source: 'file', generated: true };
  }

  await fs.mkdir(storeDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  await fs.writeFile(generatedPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(generatedPath, 0o600);
  return { available: true, path: generatedPath, source: 'generated', generated: true };
};

/** Constant-time comparison of the submitted setup token. */
export const verifySetupToken = async (
  candidate: unknown,
  info: SetupTokenInfo,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> => {
  if (typeof candidate !== 'string' || candidate.trim().length < SETUP_TOKEN_MIN_LENGTH) return false;

  let expected: string | null = null;
  if (info.source === 'env') {
    expected = env.ADMIN_SETUP_TOKEN?.trim() || null;
  } else {
    expected = await readTokenFile(info.path);
  }
  if (!expected) return false;

  try {
    return timingSafeEqual(digest(expected), digest(candidate.trim()));
  } catch {
    return false;
  }
};

/** Removes a token file this process generated. Never touches env/secret files. */
export const clearGeneratedSetupToken = async (info: SetupTokenInfo | null): Promise<void> => {
  if (!info?.generated) return;
  await fs.rm(info.path, { force: true }).catch(() => undefined);
};
