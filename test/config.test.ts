import { beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config/load.js';
import { createTestKeys, type TestKeys } from './helpers.js';

let keys: TestKeys;

beforeAll(() => {
  keys = createTestKeys();
});

function yaml(body: string): string {
  return `
jwt:
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}
${body}`;
}

function load(body: string) {
  return parseConfig(yaml(body));
}

function issues(body: string): readonly string[] {
  try {
    load(body);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected configuration to be rejected');
}

const SERVICES = `
services:
  n8n:
    url: http://n8n:5678
  grafana-main:
    url: http://grafana:3000
  fallback:
    url: http://fallback:6473
`;

describe('defaults', () => {
  it('applies documented defaults', () => {
    const config = load(`${SERVICES}
routes:
  - target: n8n
  - fallback:
      service: fallback
`);

    expect(config.jwt.algorithm).toBe('RS256');
    expect(config.jwt.issuer).toBe('homelab-gateway');
    expect(config.jwt.audience).toEqual(['homelab']);
    expect(config.server.port).toBe(6473);
    expect(config.server.maxBodySizeBytes).toBe(1_048_576);
    expect(config.server.upstreamTimeoutMs).toBe(30_000);
    expect(config.mapping.enabled).toBe(true);
    expect(config.tokenLog.path).toBe('/data/tokens.jsonl');
  });

  it('defaults service to target and auth to true', () => {
    const config = load(`${SERVICES}
routes:
  - target: n8n
  - fallback:
      service: fallback
`);

    const route = config.routes[0]!;
    expect(route.service.name).toBe('n8n');
    expect(route.service.origin).toBe('http://n8n:5678');
    expect(route.auth).toBe(true);
  });

  it('honours an explicit service and auth: false', () => {
    const config = load(`${SERVICES}
routes:
  - target: grafana
    service: grafana-main
  - target: node-red
    service: n8n
    auth: false
  - fallback:
      service: fallback
`);

    expect(config.routes[0]!.service.name).toBe('grafana-main');
    expect(config.routes[1]!.auth).toBe(false);
  });
});

describe('validation', () => {
  it('requires services and routes', () => {
    expect(issues('\nroutes: []\n')).toContain('services: Required');
    expect(issues(SERVICES)).toContain('routes: Required');
  });

  it('allows a config with no fallback route', () => {
    const config = load(`${SERVICES}
routes:
  - target: n8n
`);

    expect(config.fallback).toBeUndefined();
    expect(config.routes).toHaveLength(1);
  });

  it('rejects more than one fallback', () => {
    expect(
      issues(`${SERVICES}
routes:
  - fallback:
      service: fallback
  - fallback:
      service: n8n
`),
    ).toContain('routes: at most one fallback route is allowed, found 2');
  });

  it('rejects auth on fallback', () => {
    expect(
      issues(`${SERVICES}
routes:
  - fallback:
      service: fallback
      auth: true
`),
    ).toContain('routes[0]: fallback must not define "auth" (fallback never authenticates)');
  });

  it('requires service on fallback', () => {
    expect(
      issues(`${SERVICES}
routes:
  - fallback: {}
`),
    ).toContain('routes[0].fallback.service: Required');
  });

  it('rejects duplicate targets, case-insensitively', () => {
    expect(
      issues(`${SERVICES}
routes:
  - target: n8n
  - target: N8N
  - fallback:
      service: fallback
`),
    ).toContain('routes[1]: duplicate target "N8N" (already defined as "n8n")');
  });

  it('rejects unknown services', () => {
    expect(
      issues(`${SERVICES}
routes:
  - target: nope
  - fallback:
      service: fallback
`),
    ).toContain('routes[0]: unknown service "nope"');
  });

  it('rejects unknown route fields and the removed name field', () => {
    expect(
      issues(`${SERVICES}
routes:
  - target: n8n
    prioritY: 1
  - fallback:
      service: fallback
`).join('\n'),
    ).toMatch(/routes\[0\].*Unrecognized key/);

    expect(
      issues(`${SERVICES}
routes:
  - name: n8n
    target: n8n
  - fallback:
      service: fallback
`),
    ).toContain('routes[0]: routes do not have a "name" field, use "target"');
  });

  it('rejects a target that is a URL', () => {
    expect(
      issues(`${SERVICES}
routes:
  - target: http://192.168.1.20:5678
  - fallback:
      service: fallback
`).join('\n'),
    ).toMatch(/is not a valid identifier/);
  });

  it('rejects invalid service URLs', () => {
    expect(
      issues(`
services:
  bad:
    url: not-a-url
  fallback:
    url: http://fallback:6473
routes:
  - fallback:
      service: fallback
`).join('\n'),
    ).toMatch(/services.bad: invalid URL/);

    expect(
      issues(`
services:
  bad:
    url: ftp://example.com
  fallback:
    url: http://fallback:6473
routes:
  - fallback:
      service: fallback
`).join('\n'),
    ).toMatch(/unsupported URL scheme/);
  });

  it('rejects symmetric algorithms and "none"', () => {
    for (const algorithm of ['HS256', 'none']) {
      const config = `
jwt:
  algorithm: ${algorithm}
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}
${SERVICES}
routes:
  - fallback:
      service: fallback
`;
      expect(() => parseConfig(config)).toThrow(/jwt.algorithm/);
    }
  });

  it('rejects missing key files', () => {
    const config = `
jwt:
  public_key: /nonexistent/public.pem
  private_key: /nonexistent/private.pem
${SERVICES}
routes:
  - fallback:
      service: fallback
`;
    expect(() => parseConfig(config)).toThrow(/key file is missing or not readable/);
  });

  it('rejects invalid mapping', () => {
    expect(
      issues(`${SERVICES}
routes:
  - target: n8n
    mapping:
      path:
        strip_prefix: n8n/
  - fallback:
      service: fallback
`),
    ).toContain('routes[0]: mapping.path.strip_prefix must start with "/" (got "n8n/")');

    expect(
      issues(`${SERVICES}
routes:
  - target: n8n
    mapping:
      path:
        prefix: /n8n/
  - fallback:
      service: fallback
`).join('\n'),
    ).toMatch(/Unrecognized key/);
  });

  it('rejects invalid units', () => {
    expect(
      issues(`
server:
  max_body_size: enormous
${SERVICES}
routes:
  - fallback:
      service: fallback
`).join('\n'),
    ).toMatch(/server.max_body_size: invalid size/);
  });

  it('rejects YAML syntax errors', () => {
    expect(() => parseConfig('services: [\n')).toThrow(/YAML syntax error/);
  });

  it('reports every problem at once', () => {
    const found = issues(`${SERVICES}
routes:
  - target: n8n
  - target: n8n
  - target: unknown-service-target
  - target: http://not-an-identifier
`);
    expect(found.length).toBeGreaterThanOrEqual(3);
  });
});

describe('external services', () => {
  const WORKER = `
services:
  worker:
    url: https://router.example.workers.dev
    access:
      client_id: abc123.access
      client_secret_env: CF_ACCESS_SECRET_WORKER
    timeout: 10s
  fallback:
    url: http://fallback:6473
`;

  it('accepts an https origin with a Cloudflare Access service token', () => {
    const config = load(`${WORKER}
routes:
  - target: worker
  - fallback:
      service: fallback
`);

    const worker = config.services.get('worker')!;
    expect(worker.origin).toBe('https://router.example.workers.dev');
    expect(worker.tls).toBe(true);
    expect(worker.timeoutMs).toBe(10_000);
    expect(worker.access).toEqual({
      clientId: 'abc123.access',
      secret: { kind: 'env', name: 'CF_ACCESS_SECRET_WORKER' },
    });
  });

  it('leaves ordinary internal services untouched', () => {
    const config = load(`${SERVICES}
routes:
  - fallback:
      service: fallback
`);

    const n8n = config.services.get('n8n')!;
    expect(n8n.tls).toBe(false);
    expect(n8n.access).toBeUndefined();
    expect(n8n.timeoutMs).toBeUndefined();
  });

  it('resolves client_secret_file relative to the config directory', () => {
    const config = parseConfig(
      yaml(`
services:
  worker:
    url: https://router.example.workers.dev
    access:
      client_id: abc123.access
      client_secret_file: secrets/cf-access.txt
routes:
  - target: worker
`),
      { baseDir: '/etc/gate' },
    );

    expect(config.services.get('worker')!.access?.secret).toEqual({
      kind: 'file',
      path: '/etc/gate/secrets/cf-access.txt',
    });
  });

  it('refuses an inline client_secret and says what to use instead', () => {
    expect(
      issues(`
services:
  worker:
    url: https://router.example.workers.dev
    access:
      client_id: abc123.access
      client_secret: super-secret
routes:
  - target: worker
`).join('\n'),
    ).toMatch(/client_secret must not be written into the config file/);
  });

  it('requires exactly one secret source', () => {
    expect(
      issues(`
services:
  worker:
    url: https://router.example.workers.dev
    access:
      client_id: abc123.access
routes:
  - target: worker
`),
    ).toContain('services.worker: access requires client_secret_file or client_secret_env');

    expect(
      issues(`
services:
  worker:
    url: https://router.example.workers.dev
    access:
      client_id: abc123.access
      client_secret_env: A
      client_secret_file: /b
routes:
  - target: worker
`),
    ).toContain(
      'services.worker: access must set exactly one of client_secret_file and client_secret_env, not both',
    );
  });

  it('refuses to send a service token over plaintext http', () => {
    expect(
      issues(`
services:
  worker:
    url: http://router.example.workers.dev
    access:
      client_id: abc123.access
      client_secret_env: CF_ACCESS_SECRET_WORKER
routes:
  - target: worker
`).join('\n'),
    ).toMatch(/access requires an https:\/\/ url/);
  });

  it('rejects an invalid per-service timeout', () => {
    expect(
      issues(`
services:
  worker:
    url: https://router.example.workers.dev
    timeout: soon
  fallback:
    url: http://fallback:6473
routes:
  - fallback:
      service: fallback
`).join('\n'),
    ).toMatch(/services\.worker\.timeout: invalid duration/);
  });
});
