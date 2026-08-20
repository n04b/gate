import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { parseConfig } from '../src/config/load.js';
import type { ServiceConfig } from '../src/config/types.js';
import {
  AccessCredentialError,
  resolveAccessCredentials,
} from '../src/proxy/accessCredentials.js';
import { createProxy } from '../src/proxy/proxy.js';
import { buildServer } from '../src/server.js';
import {
  createTestKeys,
  startTlsUpstream,
  startUpstream,
  tempDir,
  type TestKeys,
  type TlsUpstreamServer,
  type UpstreamServer,
} from './helpers.js';

let keys: TestKeys;
let worker: TlsUpstreamServer;
let internal: UpstreamServer;

beforeAll(async () => {
  keys = createTestKeys();
  [worker, internal] = await Promise.all([startTlsUpstream('worker'), startUpstream('internal')]);
});

afterAll(async () => {
  await Promise.all([worker.close(), internal.close()]);
});

function service(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return { name: 'worker', origin: worker.url, basePath: '', tls: true, ...overrides };
}

describe('access credential resolution', () => {
  const fromEnv = (name: string): ServiceConfig =>
    service({ access: { clientId: 'abc.access', secret: { kind: 'env', name } } });

  it('reads a secret from an environment variable', () => {
    const resolved = resolveAccessCredentials([fromEnv('CF_SECRET')], { CF_SECRET: 'shhh' });

    expect(resolved.get('worker')).toEqual({ clientId: 'abc.access', clientSecret: 'shhh' });
  });

  it('reads a secret from a file, ignoring the trailing newline', () => {
    const path = join(tempDir('gate-secret-'), 'cf-access.txt');
    writeFileSync(path, 'file-secret\n');

    const resolved = resolveAccessCredentials(
      [service({ access: { clientId: 'abc.access', secret: { kind: 'file', path } } })],
      {},
    );

    expect(resolved.get('worker')?.clientSecret).toBe('file-secret');
  });

  it('ignores services with no access configured', () => {
    expect(resolveAccessCredentials([service()], {}).size).toBe(0);
  });

  it('refuses to start when the environment variable is unset or empty', () => {
    expect(() => resolveAccessCredentials([fromEnv('CF_SECRET')], {})).toThrow(
      AccessCredentialError,
    );
    expect(() => resolveAccessCredentials([fromEnv('CF_SECRET')], { CF_SECRET: '  ' })).toThrow(
      /is empty/,
    );
  });

  it('refuses to start when the secret file is missing', () => {
    expect(() =>
      resolveAccessCredentials(
        [service({ access: { clientId: 'a', secret: { kind: 'file', path: '/nope/absent' } } })],
        {},
      ),
    ).toThrow(/cannot read \/nope\/absent/);
  });

  it('rejects a secret that could inject a header', () => {
    expect(() =>
      resolveAccessCredentials([fromEnv('CF_SECRET')], {
        CF_SECRET: 'good\r\nx-injected: evil',
      }),
    ).toThrow(/not valid in a header value/);
  });
});

describe('routing to an external Cloudflare origin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = parseConfig(`
logging:
  level: silent

jwt:
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}

services:
  worker:
    url: ${worker.url}
    access:
      client_id: abc123.access
      client_secret_env: CF_ACCESS_SECRET_WORKER
  internal:
    url: ${internal.url}

routes:
  - target: worker
    auth: false
  - target: internal
    auth: false
`);

    app = await buildServer({
      config,
      // The throwaway CA is pinned so the real TLS handshake is exercised.
      proxy: createProxy({
        upstreamTimeoutMs: 2000,
        credentials: resolveAccessCredentials(config.services.values(), {
          CF_ACCESS_SECRET_WORKER: 'worker-secret',
        }),
        tls: { ca: worker.ca },
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('proxies to an https origin over a verified TLS connection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/run?x=1',
      headers: { 'x-target': 'worker' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().upstream).toBe('worker');
    expect(worker.requests.at(-1)?.url).toBe('/api/run?x=1');
  });

  it('presents the Cloudflare Access service token', async () => {
    await app.inject({ method: 'GET', url: '/x', headers: { 'x-target': 'worker' } });

    const received = worker.requests.at(-1)!.headers;
    expect(received['cf-access-client-id']).toBe('abc123.access');
    expect(received['cf-access-client-secret']).toBe('worker-secret');
  });

  it('never lets a client choose the credential Gate presents', async () => {
    await app.inject({
      method: 'GET',
      url: '/x',
      headers: {
        'x-target': 'worker',
        'cf-access-client-id': 'attacker.access',
        'cf-access-client-secret': 'attacker-secret',
        'cf-access-jwt-assertion': 'forged',
      },
    });

    const received = worker.requests.at(-1)!.headers;
    expect(received['cf-access-client-id']).toBe('abc123.access');
    expect(received['cf-access-client-secret']).toBe('worker-secret');
    expect(received['cf-access-jwt-assertion']).toBeUndefined();
  });

  it('sends no service token to a service that has none', async () => {
    await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': 'internal', 'cf-access-client-id': 'attacker.access' },
    });

    const received = internal.requests.at(-1)!.headers;
    expect(received['cf-access-client-id']).toBeUndefined();
    expect(received['cf-access-client-secret']).toBeUndefined();
  });
});

describe('per-service egress timeout', () => {
  let app: FastifyInstance;
  let slow: UpstreamServer;

  beforeAll(async () => {
    slow = await startUpstream('slow');
    slow.respondWith(() => {
      /* never responds — the timeout is what ends the request */
    });

    const config = parseConfig(`
logging:
  level: silent

server:
  upstream_timeout: 30s

jwt:
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}

services:
  impatient:
    url: ${slow.url}
    timeout: 250ms
  patient:
    url: ${slow.url}

routes:
  - target: impatient
    auth: false
  - target: patient
    auth: false
`);

    app = await buildServer({ config });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await slow.close();
  });

  it('applies the per-service timeout instead of the global one', async () => {
    const startedAt = Date.now();
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': 'impatient' },
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: 'gateway_timeout' });
    // The 30s global budget would not have fired yet.
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
