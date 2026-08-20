import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseConfig } from '../src/config/load.js';
import { createTokenIssuer } from '../src/jwt/issuer.js';
import { buildServer } from '../src/server.js';
import { createTestKeys, startUpstream, type TestKeys, type UpstreamServer } from './helpers.js';

let keys: TestKeys;
let n8n: UpstreamServer;
let grafana: UpstreamServer;
let fallback: UpstreamServer;
let app: FastifyInstance;

function configText(overrides: { server?: string; mapping?: string } = {}): string {
  return `
server:
  max_body_size: ${'1KB'}
  upstream_timeout: 2s
${overrides.server ?? ''}
logging:
  level: silent

jwt:
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}

mapping:
  enabled: ${overrides.mapping ?? 'true'}

services:
  n8n:
    url: ${n8n.url}
  grafana-main:
    url: ${grafana.url}
  fallback:
    url: ${fallback.url}
  dead:
    url: http://127.0.0.1:1

routes:
  - target: grafana
    service: grafana-main
    auth: false

  - target: n8n
    mapping:
      path:
        strip_prefix: /n8n/

  - target: open
    service: n8n
    auth: false

  - target: broken
    service: dead
    auth: false

  - fallback:
      service: fallback
`;
}

async function buildApp(overrides?: { server?: string; mapping?: string }): Promise<FastifyInstance> {
  const config = parseConfig(configText(overrides));
  return buildServer({ config });
}

async function token(
  claims: { subject?: string; target?: string; expiresInMs?: number } = {},
): Promise<string> {
  const config = parseConfig(configText());
  const issuer = createTokenIssuer(config.jwt);
  const issued = await issuer.issue({
    subject: claims.subject ?? 'tester',
    target: claims.target ?? 'n8n',
    expiresInMs: claims.expiresInMs ?? 60_000,
  });
  return issued.token;
}

beforeAll(async () => {
  keys = createTestKeys();
  [n8n, grafana, fallback] = await Promise.all([
    startUpstream('n8n'),
    startUpstream('grafana'),
    startUpstream('fallback'),
  ]);
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await Promise.all([n8n.close(), grafana.close(), fallback.close()]);
});

describe('health', () => {
  it('answers without a target and is never proxied', async () => {
    const before = fallback.requests.length;
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(fallback.requests.length).toBe(before);
  });

  it('routes other methods on /health like any other request', async () => {
    const response = await app.inject({ method: 'POST', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().upstream).toBe('fallback');
    expect(fallback.requests.at(-1)?.url).toBe('/health');
  });
});

describe('target resolution', () => {
  it('uses fallback when neither JWT nor X-Target is present', async () => {
    const response = await app.inject({ method: 'GET', url: '/unknown/path' });

    expect(response.statusCode).toBe(200);
    expect(response.json().upstream).toBe('fallback');
    expect(fallback.requests.at(-1)?.url).toBe('/unknown/path');
  });

  it('routes by X-Target when no JWT is present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { 'x-target': 'grafana' },
    });

    expect(response.json().upstream).toBe('grafana');
  });

  it('matches targets case-insensitively', async () => {
    for (const value of ['grafana', 'GRAFANA', 'GrAfAnA']) {
      const response = await app.inject({ method: 'GET', url: '/x', headers: { 'x-target': value } });
      expect(response.json().upstream).toBe('grafana');
    }
  });

  it('uses the last X-Target value when the header repeats', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': ['open', 'grafana'] },
    });

    expect(response.json().upstream).toBe('grafana');
  });

  it('falls back on an unknown target', async () => {
    const response = await app.inject({ method: 'GET', url: '/x', headers: { 'x-target': 'nope' } });
    expect(response.json().upstream).toBe('fallback');
  });

  it('never treats a URL-shaped target as an upstream', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': grafana.url },
    });

    expect(response.json().upstream).toBe('fallback');
  });

  it('prefers the JWT target over X-Target', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: {
        'x-target': 'open',
        authorization: `Bearer ${await token({ target: 'grafana' })}`,
      },
    });

    expect(response.json().upstream).toBe('grafana');
  });
});

describe('no fallback configured', () => {
  let noFallbackApp: FastifyInstance;

  beforeAll(async () => {
    const config = parseConfig(`
logging:
  level: silent

jwt:
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}

services:
  grafana-main:
    url: ${grafana.url}

routes:
  - target: grafana
    service: grafana-main
    auth: false
`);
    noFallbackApp = await buildServer({ config });
    await noFallbackApp.ready();
  });

  afterAll(async () => {
    await noFallbackApp.close();
  });

  it('still routes a matching target', async () => {
    const response = await noFallbackApp.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': 'grafana' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().upstream).toBe('grafana');
  });

  it('returns 400 no_target when neither JWT nor X-Target is present', async () => {
    const response = await noFallbackApp.inject({ method: 'GET', url: '/unknown/path' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'no_target' });
  });

  it('returns 404 no_route when the resolved target has no route', async () => {
    const response = await noFallbackApp.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': 'nope' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'no_route' });
  });
});

describe('JWT failures', () => {
  it('returns 401 for an invalid JWT and does not fall back', async () => {
    const before = fallback.requests.length;
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': 'grafana', authorization: 'Bearer not.a.jwt' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'jwt_invalid' });
    expect(fallback.requests.length).toBe(before);
  });

  it('returns 401 for an expired JWT', async () => {
    const expired = await token({ expiresInMs: -60_000 });
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { authorization: `Bearer ${expired}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 for a non-bearer Authorization header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'jwt_invalid' });
  });

  it('returns 400 for a valid JWT without a target and ignores X-Target', async () => {
    const config = parseConfig(configText());
    const issuer = createTokenIssuer(config.jwt);
    const { token: noTarget } = await issuer.issue({
      subject: 'github',
      target: '',
      expiresInMs: 60_000,
    });

    const before = grafana.requests.length + fallback.requests.length;
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': 'grafana', authorization: `Bearer ${noTarget}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'jwt_target_missing' });
    expect(grafana.requests.length + fallback.requests.length).toBe(before);
  });
});

describe('route authentication', () => {
  it('rejects an authenticated route reached without a JWT — never falls back', async () => {
    const before = fallback.requests.length + n8n.requests.length;
    const response = await app.inject({
      method: 'GET',
      url: '/n8n/webhook/github',
      headers: { 'x-target': 'n8n' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(fallback.requests.length + n8n.requests.length).toBe(before);
  });

  it('accepts an authenticated route with a valid JWT', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/n8n/webhook/github',
      headers: { authorization: `Bearer ${await token({ target: 'n8n' })}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().upstream).toBe('n8n');
  });

  it('allows a public route without a JWT', async () => {
    const response = await app.inject({ method: 'GET', url: '/x', headers: { 'x-target': 'open' } });
    expect(response.statusCode).toBe(200);
  });
});

describe('proxying', () => {
  it('preserves method, path, query, body and application headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhook/github?source=github&x=1',
      headers: {
        'x-target': 'open',
        'content-type': 'application/json',
        'x-custom': 'test',
      },
      payload: '{"hello":"world"}',
    });

    expect(response.statusCode).toBe(200);

    const received = n8n.requests.at(-1)!;
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/webhook/github?source=github&x=1');
    expect(received.body).toBe('{"hello":"world"}');
    expect(received.headers['content-type']).toBe('application/json');
    expect(received.headers['x-custom']).toBe('test');
  });

  it('does not forward X-Target or Authorization upstream', async () => {
    await app.inject({
      method: 'GET',
      url: '/n8n/test',
      headers: {
        'x-target': 'ignored',
        authorization: `Bearer ${await token({ target: 'n8n' })}`,
      },
    });

    const received = n8n.requests.at(-1)!;
    expect(received.headers['x-target']).toBeUndefined();
    expect(received.headers['authorization']).toBeUndefined();
    expect(received.headers['x-forwarded-for']).toBeDefined();
    expect(received.headers['x-request-id']).toBeDefined();
  });

  it('proxies the upstream status, headers and body back', async () => {
    grafana.respondWith((_req, res) => {
      res.writeHead(418, { 'content-type': 'text/plain', 'x-teapot': 'yes' });
      res.end('short and stout');
    });

    const response = await app.inject({
      method: 'GET',
      url: '/brew',
      headers: { 'x-target': 'grafana' },
    });

    expect(response.statusCode).toBe(418);
    expect(response.headers['x-teapot']).toBe('yes');
    expect(response.body).toBe('short and stout');

    grafana.respondWith(defaultGrafanaResponse);
  });

  it('proxies every HTTP method', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const withBody = method === 'PUT' || method === 'PATCH';
      const response = await app.inject({
        method,
        url: '/thing',
        headers: { 'x-target': 'open', 'content-type': 'text/plain' },
        ...(withBody ? { payload: 'payload' } : {}),
      });

      expect(response.statusCode).toBe(200);
      expect(n8n.requests.at(-1)?.method).toBe(method);
      if (withBody) expect(n8n.requests.at(-1)?.body).toBe('payload');
    }
  });

  it('proxies HEAD without a body', async () => {
    const response = await app.inject({
      method: 'HEAD' as const,
      url: '/x',
      headers: { 'x-target': 'open' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(n8n.requests.at(-1)?.method).toBe('HEAD');
  });

  it('proxies redirects back instead of following them', async () => {
    grafana.respondWith((_req, res) => {
      res.writeHead(302, { location: 'http://elsewhere.example.com/login' });
      res.end();
    });

    const response = await app.inject({ method: 'GET', url: '/x', headers: { 'x-target': 'grafana' } });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('http://elsewhere.example.com/login');

    grafana.respondWith(defaultGrafanaResponse);
  });

  it('proxies an empty 204 response', async () => {
    grafana.respondWith((_req, res) => {
      res.writeHead(204);
      res.end();
    });

    const response = await app.inject({ method: 'GET', url: '/x', headers: { 'x-target': 'grafana' } });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');

    grafana.respondWith(defaultGrafanaResponse);
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-target': 'broken' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'bad_gateway' });
  });

  it('returns 504 when the upstream exceeds the timeout', async () => {
    const slow = await startUpstream('slow');
    slow.respondWith(() => {
      /* never responds */
    });

    const config = parseConfig(`
server:
  upstream_timeout: 300ms
logging:
  level: silent
jwt:
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}
services:
  slow:
    url: ${slow.url}
  fallback:
    url: ${fallback.url}
routes:
  - target: slow
    auth: false
  - fallback:
      service: fallback
`);

    const slowApp = await buildServer({ config });
    try {
      const response = await slowApp.inject({
        method: 'GET',
        url: '/x',
        headers: { 'x-target': 'slow' },
      });
      expect(response.statusCode).toBe(504);
      expect(response.json()).toEqual({ error: 'gateway_timeout' });
    } finally {
      await slowApp.close();
      await slow.close();
    }
  });
});

describe('path mapping', () => {
  it('strips the configured prefix', async () => {
    const bearer = `Bearer ${await token({ target: 'n8n' })}`;

    const cases: Array<[string, string]> = [
      ['/n8n/', '/'],
      ['/n8n/test', '/test'],
      ['/n8n/webhook/github', '/webhook/github'],
      ['/n8n/api/v1/test', '/api/v1/test'],
    ];

    for (const [requested, expected] of cases) {
      await app.inject({ method: 'GET', url: requested, headers: { authorization: bearer } });
      expect(n8n.requests.at(-1)?.url).toBe(expected);
    }
  });

  it('keeps the query string while stripping the prefix', async () => {
    await app.inject({
      method: 'GET',
      url: '/n8n/webhook?a=1',
      headers: { authorization: `Bearer ${await token({ target: 'n8n' })}` },
    });

    expect(n8n.requests.at(-1)?.url).toBe('/webhook?a=1');
  });

  it('never maps the fallback path', async () => {
    await app.inject({ method: 'GET', url: '/n8n/webhook/github' });
    expect(fallback.requests.at(-1)?.url).toBe('/n8n/webhook/github');
  });

  it('passes the path through when mapping is globally disabled', async () => {
    const disabled = await buildApp({ mapping: 'false' });
    try {
      await disabled.inject({
        method: 'GET',
        url: '/n8n/webhook/github',
        headers: { authorization: `Bearer ${await token({ target: 'n8n' })}` },
      });
      expect(n8n.requests.at(-1)?.url).toBe('/n8n/webhook/github');
    } finally {
      await disabled.close();
    }
  });
});

describe('request body limit', () => {
  it('rejects a declared body larger than the limit', async () => {
    const before = n8n.requests.length;
    const response = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'x-target': 'open', 'content-type': 'text/plain' },
      payload: 'x'.repeat(2048),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: 'payload_too_large' });
    expect(n8n.requests.length).toBe(before);
  });

  it('allows a body within the limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'x-target': 'open', 'content-type': 'text/plain' },
      payload: 'x'.repeat(512),
    });

    expect(response.statusCode).toBe(200);
    expect(n8n.requests.at(-1)?.body.length).toBe(512);
  });
});

function defaultGrafanaResponse(_req: unknown, res: { writeHead: Function; end: Function }): void {
  res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'grafana' });
  res.end(JSON.stringify({ upstream: 'grafana' }));
}
