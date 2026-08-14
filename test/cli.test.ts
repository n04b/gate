import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { run } from '../src/cli.js';
import { createTestKeys, tempDir, type TestKeys } from './helpers.js';

let keys: TestKeys;
let workDir: string;
let configPath: string;
let tokenLogPath: string;

let stdout: string[];
let stderr: string[];

beforeAll(() => {
  keys = createTestKeys();
  workDir = tempDir('gate-cli-');
  configPath = join(workDir, 'gate.yaml');
  tokenLogPath = join(workDir, 'tokens.jsonl');

  writeFileSync(
    configPath,
    `
jwt:
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}

token_log:
  path: ${tokenLogPath}

services:
  n8n:
    url: http://n8n:5678
  fallback:
    url: http://fallback:8080

routes:
  - target: n8n
  - fallback:
      service: fallback
`,
  );
});

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function cli(...args: string[]): Promise<number> {
  return run(['token', 'create', '--config', configPath, ...args]);
}

function logLines(): Array<Record<string, unknown>> {
  if (!existsSync(tokenLogPath)) return [];
  return readFileSync(tokenLogPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('argument validation', () => {
  it('requires a subject and a target', async () => {
    expect(await cli('--target', 'n8n', '--expires', '1h')).toBe(1);
    expect(stderr.join('')).toContain('--subject is required');

    expect(await cli('--subject', 'github', '--expires', '1h')).toBe(1);
    expect(stderr.join('')).toContain('--target is required');
  });

  it('fails when neither --expires nor --no-expiry is given', async () => {
    expect(await cli('--subject', 'github', '--target', 'n8n')).toBe(1);
    expect(stderr.join('')).toContain('either --expires or --no-expiry is required');
  });

  it('rejects --expires together with --no-expiry', async () => {
    expect(await cli('--subject', 'github', '--target', 'n8n', '--expires', '1h', '--no-expiry')).toBe(1);
    expect(stderr.join('')).toContain('mutually exclusive');
  });

  it('rejects an unparsable duration and unknown flags', async () => {
    expect(await cli('--subject', 'a', '--target', 'n8n', '--expires', 'soon')).toBe(1);
    expect(await cli('--subject', 'a', '--target', 'n8n', '--expires', '1h', '--evil')).toBe(1);
  });

  it('rejects unknown commands', async () => {
    expect(await run(['token', 'revoke'])).toBe(1);
    expect(await run(['nonsense'])).toBe(1);
  });

  it('writes nothing to the token log when validation fails', () => {
    expect(logLines()).toHaveLength(0);
  });
});

describe('token create', () => {
  it('issues an expiring token and logs its metadata', async () => {
    const code = await cli(
      '--subject',
      'github',
      '--target',
      'n8n',
      '--expires',
      '1h',
      '--issued-by',
      'misha@laptop',
      '--note',
      'github webhook automation',
    );

    expect(code).toBe(0);

    const token = stdout.join('').trim();
    expect(token.split('.')).toHaveLength(3);
    expect(decodeProtectedHeader(token).alg).toBe('RS256');

    const claims = decodeJwt(token);
    expect(claims.iss).toBe('homelab-gateway');
    expect(claims.aud).toBe('homelab');
    expect(claims.sub).toBe('github');
    expect(claims['target']).toBe('n8n');
    expect(claims.jti).toBeTypeOf('string');
    expect(claims.exp).toBe((claims.iat as number) + 3600);
    expect(claims['note']).toBeUndefined();

    const [record] = logLines();
    expect(record).toMatchObject({
      jti: claims.jti,
      sub: 'github',
      target: 'n8n',
      iat: claims.iat,
      exp: claims.exp,
      issued_by: 'misha@laptop',
      note: 'github webhook automation',
    });
  });

  it('never writes the token itself to the log', () => {
    const raw = readFileSync(tokenLogPath, 'utf8');
    expect(raw).not.toContain('eyJ');
    for (const record of logLines()) {
      expect(Object.keys(record)).not.toContain('token');
      expect(Object.keys(record)).not.toContain('jwt');
    }
  });

  it('issues a non-expiring token only with --no-expiry', async () => {
    expect(await cli('--subject', 'automation', '--target', 'n8n', '--no-expiry')).toBe(0);

    const claims = decodeJwt(stdout.join('').trim());
    expect(claims.exp).toBeUndefined();

    const record = logLines().at(-1)!;
    expect(record['exp']).toBeUndefined();
    expect(record['issued_by']).toBeTypeOf('string');
    expect(record['note']).toBeUndefined();
  });

  it('appends without touching earlier records', async () => {
    const before = logLines();
    const rawBefore = readFileSync(tokenLogPath, 'utf8');

    expect(await cli('--subject', 'laptop', '--target', 'n8n', '--expires', '15m')).toBe(0);

    const after = logLines();
    expect(after).toHaveLength(before.length + 1);
    expect(readFileSync(tokenLogPath, 'utf8').startsWith(rawBefore)).toBe(true);
  });

  it('warns when the target has no configured route', async () => {
    expect(await cli('--subject', 'a', '--target', 'not-configured', '--expires', '5m')).toBe(0);
    expect(stderr.join('')).toContain('no route is configured for target "not-configured"');
  });
});
