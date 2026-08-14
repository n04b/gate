import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigError, parseConfig } from './config/load.js';
import { DEFAULT_CONFIG_YAML } from './config/template.js';

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export interface BootstrapResult {
  readonly configCreated: boolean;
  readonly keysCreated: boolean;
  /** Path Gate should actually load, which may be the fallback. */
  readonly configPath: string;
  /** True when the configured path was not writable and the fallback was used. */
  readonly configFallbackUsed: boolean;
  readonly publicKeyPath: string | undefined;
  readonly privateKeyPath: string | undefined;
}

/**
 * Where the default config goes when the configured location cannot be written.
 * A bind-mounted ./config belongs to the host user, so a container running as
 * `node` often cannot create files in it; the data volume always works.
 */
export const FALLBACK_CONFIG_PATH = '/data/gate.yaml';

export interface BootstrapOptions {
  readonly fallbackConfigPath?: string;
}

/**
 * Returns the config file Gate should load: the configured one when it exists,
 * otherwise a previously generated fallback. Nothing is written.
 */
export function resolveConfigPath(
  configPath: string,
  fallbackConfigPath: string = FALLBACK_CONFIG_PATH,
): string {
  if (existsSync(configPath)) return configPath;
  if (existsSync(fallbackConfigPath)) return fallbackConfigPath;
  return configPath;
}

/**
 * First-start bootstrap: writes a default configuration when none exists and
 * generates the JWT key pair the configuration points at.
 *
 * Both steps are strictly create-if-missing — an existing config file or key is
 * never overwritten, so restarts and upgrades leave a deployment untouched.
 * Key material is only ever created at runtime, never baked into the image.
 */
export function bootstrap(configPath: string, options: BootstrapOptions = {}): BootstrapResult {
  const fallbackConfigPath = options.fallbackConfigPath ?? FALLBACK_CONFIG_PATH;
  const {
    path: effectivePath,
    created: configCreated,
    fallbackUsed: configFallbackUsed,
  } = placeConfig(configPath, fallbackConfigPath);

  let config;
  try {
    config = parseConfig(readFileSync(effectivePath, 'utf8'), {
      checkKeyFiles: false,
      baseDir: dirname(effectivePath),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      // The config is the operator's to fix; startup reports it in full.
      return {
        configCreated,
        configFallbackUsed,
        keysCreated: false,
        configPath: effectivePath,
        publicKeyPath: undefined,
        privateKeyPath: undefined,
      };
    }
    throw error;
  }

  const { publicKeyPath, privateKeyPath } = config.jwt;
  const keysCreated = ensureKeyPair(publicKeyPath, privateKeyPath);

  return {
    configCreated,
    configFallbackUsed,
    keysCreated,
    configPath: effectivePath,
    publicKeyPath,
    privateKeyPath,
  };
}

export interface ConfigPlacement {
  readonly path: string;
  readonly created: boolean;
  readonly fallbackUsed: boolean;
}

/**
 * Creates the default config at the configured path, or — when that directory
 * belongs to another user, as a bind-mounted ./config usually does — at the
 * fallback path inside the data volume. Gate must not crash-loop over this.
 */
export function placeConfig(configPath: string, fallbackPath: string): ConfigPlacement {
  if (existsSync(configPath)) {
    return { path: configPath, created: false, fallbackUsed: false };
  }
  if (existsSync(fallbackPath)) {
    return { path: fallbackPath, created: false, fallbackUsed: true };
  }

  try {
    ensureConfig(configPath);
    return { path: configPath, created: true, fallbackUsed: false };
  } catch (error) {
    if (!(error instanceof PermissionError) || configPath === fallbackPath) throw error;
  }

  ensureConfig(fallbackPath);
  return { path: fallbackPath, created: true, fallbackUsed: true };
}

class PermissionError extends BootstrapError {}

const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Writes the default config when the path is free. Exported for tests. */
export function ensureConfig(configPath: string): boolean {
  if (existsSync(configPath)) return false;

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    // `wx` fails if another process won the race, which is the desired outcome:
    // whoever wrote first owns the file.
    writeFileSync(configPath, DEFAULT_CONFIG_YAML, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;

    const message =
      `cannot create the default config at ${configPath}: ${(error as Error).message}. ` +
      'Mount the directory writable, or provide a config file yourself.';
    throw code !== undefined && PERMISSION_CODES.has(code)
      ? new PermissionError(message)
      : new BootstrapError(message);
  }

  return true;
}

/** Creates the key pair when either half is missing. Exported for tests. */
export function ensureKeyPair(publicKeyPath: string, privateKeyPath: string): boolean {
  const hasPrivate = existsSync(privateKeyPath);
  const hasPublic = existsSync(publicKeyPath);
  if (hasPrivate && hasPublic) return false;

  try {
    if (hasPrivate) {
      // A half-present pair: derive the public key rather than replacing a
      // private key that may already have issued tokens.
      const publicKey = createPublicKey(readFileSync(privateKeyPath, 'utf8'));
      writeKey(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }) as string, 0o644);
      return true;
    }

    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeKey(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 0o600);
    writeKey(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }) as string, 0o644);
    return true;
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(
      `cannot generate the JWT key pair (${privateKeyPath}, ${publicKeyPath}): ` +
        `${(error as Error).message}. Point jwt.public_key / jwt.private_key at a writable ` +
        'location, or create the pair yourself with scripts/generate-keys.sh.',
    );
  }
}

function writeKey(path: string, pem: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, pem, { encoding: 'utf8', mode, flag: 'wx' });
}

/** Bootstrap runs only when explicitly enabled; the Docker image enables it. */
export function bootstrapEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
