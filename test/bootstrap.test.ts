import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootstrap,
  bootstrapEnabled,
  BootstrapError,
  ensureConfig,
  ensureKeyPair,
  placeConfig,
  resolveConfigPath,
} from '../src/bootstrap.js';
import { DEFAULT_CONFIG_YAML } from '../src/config/template.js';
import { loadConfigFile, parseConfig } from '../src/config/load.js';
import { createJwtVerifier } from '../src/jwt/verifier.js';
import { createTokenIssuer } from '../src/jwt/issuer.js';
import { tempDir } from './helpers.js';

/**
 * The shipped template points at /data, which is not writable on a dev machine.
 * Tests that run the full bootstrap install a copy rooted in a temp directory.
 */
function writeRetargetedConfig(dir: string): string {
  const configPath = join(dir, 'config', 'gate.yaml');
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(configPath, DEFAULT_CONFIG_YAML.replaceAll('/data/', `${dir}/data/`));
  return configPath;
}

describe('bootstrapEnabled', () => {
  it('is off unless explicitly enabled', () => {
    expect(bootstrapEnabled(undefined)).toBe(false);
    expect(bootstrapEnabled('')).toBe(false);
    expect(bootstrapEnabled('false')).toBe(false);
    expect(bootstrapEnabled('0')).toBe(false);

    expect(bootstrapEnabled('true')).toBe(true);
    expect(bootstrapEnabled('TRUE')).toBe(true);
    expect(bootstrapEnabled(' 1 ')).toBe(true);
    expect(bootstrapEnabled('yes')).toBe(true);
  });
});

describe('generated config', () => {
  it('is written when missing and is valid on its own', () => {
    const dir = tempDir('gate-bootstrap-');
    const configPath = join(dir, 'config', 'gate.yaml');

    expect(ensureConfig(configPath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);

    const config = parseConfig(readFileSync(configPath, 'utf8'), { checkKeyFiles: false });
    expect(config.fallback.service.name).toBe('fallback');
    expect(config.jwt.algorithm).toBe('RS256');
    expect(config.jwt.privateKeyPath).toBe('/data/keys/jwt_private.pem');
    expect(config.tokenLog.path).toBe('/data/tokens.jsonl');
  });

  it('is never overwritten on a later start', () => {
    const dir = tempDir('gate-bootstrap-');
    const configPath = join(dir, 'config', 'gate.yaml');
    ensureConfig(configPath);
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n# edited by hand\n`);

    expect(ensureConfig(configPath)).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain('# edited by hand');
  });

  it('explains an unwritable config directory', () => {
    const dir = tempDir('gate-bootstrap-');
    const readOnly = join(dir, 'config');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);

    try {
      expect(() => ensureConfig(join(readOnly, 'gate.yaml'))).toThrow(BootstrapError);
      expect(() => ensureConfig(join(readOnly, 'gate.yaml'))).toThrow(/writable/);
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });
});

describe('unwritable config mount', () => {
  /** A bind-mounted ./config owned by another user is the common case. */
  function readOnlyMount(): { primary: string; fallback: string; dir: string } {
    const dir = tempDir('gate-bootstrap-');
    const mount = join(dir, 'config');
    mkdirSync(mount);
    chmodSync(mount, 0o500);
    return { primary: join(mount, 'gate.yaml'), fallback: join(dir, 'data', 'gate.yaml'), dir };
  }

  it('falls back to the data volume instead of failing the start', () => {
    const { primary, fallback, dir } = readOnlyMount();

    try {
      const placement = placeConfig(primary, fallback);

      expect(placement.fallbackUsed).toBe(true);
      expect(placement.created).toBe(true);
      expect(placement.path).toBe(fallback);
      expect(existsSync(fallback)).toBe(true);
      expect(existsSync(primary)).toBe(false);
    } finally {
      chmodSync(join(dir, 'config'), 0o700);
    }
  });

  it('generates keys and reports the fallback path through the full bootstrap', () => {
    const { primary, fallback, dir } = readOnlyMount();
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(fallback, DEFAULT_CONFIG_YAML.replaceAll('/data/', `${dir}/data/`));

    try {
      const result = bootstrap(primary, { fallbackConfigPath: fallback });

      expect(result.configPath).toBe(fallback);
      expect(result.configFallbackUsed).toBe(true);
      expect(result.configCreated).toBe(false);
      expect(result.keysCreated).toBe(true);
      expect(existsSync(join(dir, 'data/keys/jwt_private.pem'))).toBe(true);

      loadConfigFile(fallback, { checkKeyFiles: true });
    } finally {
      chmodSync(join(dir, 'config'), 0o700);
    }
  });

  it('keeps using the fallback on later starts without rewriting it', () => {
    const { primary, fallback, dir } = readOnlyMount();

    try {
      placeConfig(primary, fallback);
      writeFileSync(fallback, `${readFileSync(fallback, 'utf8')}\n# edited\n`);

      const second = placeConfig(primary, fallback);
      expect(second.created).toBe(false);
      expect(second.fallbackUsed).toBe(true);
      expect(second.path).toBe(fallback);
      expect(readFileSync(fallback, 'utf8')).toContain('# edited');
    } finally {
      chmodSync(join(dir, 'config'), 0o700);
    }
  });

  it('prefers the mounted config once it exists', () => {
    const dir = tempDir('gate-bootstrap-');
    const primary = join(dir, 'config', 'gate.yaml');
    const fallback = join(dir, 'data', 'gate.yaml');
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(fallback, DEFAULT_CONFIG_YAML);
    writeFileSync(primary, DEFAULT_CONFIG_YAML);

    expect(resolveConfigPath(primary, fallback)).toBe(primary);
    expect(placeConfig(primary, fallback)).toEqual({
      path: primary,
      created: false,
      fallbackUsed: false,
    });
  });

  it('resolves the readable config without writing anything', () => {
    const dir = tempDir('gate-bootstrap-');
    const primary = join(dir, 'config', 'gate.yaml');
    const fallback = join(dir, 'data', 'gate.yaml');

    expect(resolveConfigPath(primary, fallback)).toBe(primary);
    expect(existsSync(primary)).toBe(false);
    expect(existsSync(fallback)).toBe(false);

    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(fallback, DEFAULT_CONFIG_YAML);
    expect(resolveConfigPath(primary, fallback)).toBe(fallback);
  });
});

describe('generated keys', () => {
  it('produces a working RS256 pair with tight permissions', async () => {
    const dir = tempDir('gate-bootstrap-');
    const configPath = writeRetargetedConfig(dir);

    const result = bootstrap(configPath);
    expect(result.configCreated).toBe(false);
    expect(result.keysCreated).toBe(true);
    expect(result.privateKeyPath).toBe(join(dir, 'data/keys/jwt_private.pem'));

    expect(statSync(result.privateKeyPath!).mode & 0o777).toBe(0o600);
    expect(statSync(result.publicKeyPath!).mode & 0o777).toBe(0o644);

    // The config Gate loads at startup — key files included — now validates.
    const config = loadConfigFile(configPath, { checkKeyFiles: true });

    const issued = await createTokenIssuer(config.jwt).issue({
      subject: 'bootstrap',
      target: 'n8n',
      expiresInMs: 60_000,
    });
    const verified = await createJwtVerifier(config.jwt).verify(issued.token);
    expect(verified.ok).toBe(true);
  });

  it('never replaces an existing pair', () => {
    const dir = tempDir('gate-bootstrap-');
    const configPath = writeRetargetedConfig(dir);
    const first = bootstrap(configPath);

    const privateBefore = readFileSync(first.privateKeyPath!, 'utf8');
    const publicBefore = readFileSync(first.publicKeyPath!, 'utf8');

    const second = bootstrap(configPath);
    expect(second.keysCreated).toBe(false);
    expect(readFileSync(first.privateKeyPath!, 'utf8')).toBe(privateBefore);
    expect(readFileSync(first.publicKeyPath!, 'utf8')).toBe(publicBefore);
  });

  it('derives the public key rather than replacing a lone private key', () => {
    const dir = tempDir('gate-bootstrap-');
    const configPath = writeRetargetedConfig(dir);
    const first = bootstrap(configPath);

    const privateBefore = readFileSync(first.privateKeyPath!, 'utf8');
    const publicBefore = readFileSync(first.publicKeyPath!, 'utf8');
    rmSync(first.publicKeyPath!);

    expect(bootstrap(configPath).keysCreated).toBe(true);
    expect(readFileSync(first.privateKeyPath!, 'utf8')).toBe(privateBefore);
    expect(readFileSync(first.publicKeyPath!, 'utf8')).toBe(publicBefore);
  });

  it('explains an unwritable key location', () => {
    const dir = tempDir('gate-bootstrap-');
    const keyDir = join(dir, 'keys');
    mkdirSync(keyDir);
    chmodSync(keyDir, 0o500);

    try {
      expect(() =>
        ensureKeyPair(join(keyDir, 'jwt_public.pem'), join(keyDir, 'jwt_private.pem')),
      ).toThrow(/cannot generate the JWT key pair/);
    } finally {
      chmodSync(keyDir, 0o700);
    }
  });
});

describe('existing deployments', () => {
  it('leaves an invalid config for startup validation to report', () => {
    const dir = tempDir('gate-bootstrap-');
    const configPath = join(dir, 'config', 'gate.yaml');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(configPath, 'services: {}\nroutes: []\n');

    const result = bootstrap(configPath);
    expect(result.configCreated).toBe(false);
    expect(result.keysCreated).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe('services: {}\nroutes: []\n');
  });
});
