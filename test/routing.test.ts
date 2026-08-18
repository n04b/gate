import { describe, expect, it } from 'vitest';
import { lastHeaderValue, singleHeaderValue } from '../src/routing/headers.js';
import { applyPathMapping, stripPathPrefix } from '../src/proxy/mapping.js';
import { buildDownstreamHeaders, buildUpstreamHeaders } from '../src/proxy/proxyHeaders.js';
import type { FallbackRoute, NormalRoute, ServiceConfig } from '../src/config/types.js';

const service: ServiceConfig = { name: 'n8n', origin: 'http://n8n:5678', basePath: '' };

const mappedRoute: NormalRoute = {
  kind: 'normal',
  target: 'n8n',
  targetKey: 'n8n',
  service,
  auth: true,
  mapping: { path: { stripPrefix: '/n8n/' } },
};

const fallbackRoute: FallbackRoute = { kind: 'fallback', service, auth: false };

describe('X-Target header selection', () => {
  it('takes the last value of repeated headers', () => {
    expect(lastHeaderValue({ 'x-target': ['grafana', 'n8n'] }, 'x-target')).toBe('n8n');
  });

  it('takes the last value of a comma-joined header', () => {
    expect(lastHeaderValue({ 'x-target': 'grafana, n8n' }, 'x-target')).toBe('n8n');
  });

  it('ignores empty values', () => {
    expect(lastHeaderValue({ 'x-target': 'n8n, ' }, 'x-target')).toBe('n8n');
    expect(lastHeaderValue({ 'x-target': '   ' }, 'x-target')).toBeUndefined();
    expect(lastHeaderValue({}, 'x-target')).toBeUndefined();
  });

  it('never comma-splits single-value headers', () => {
    expect(singleHeaderValue({ authorization: 'Bearer a,b' }, 'authorization')).toBe('Bearer a,b');
  });
});

describe('path mapping', () => {
  it('strips the configured prefix', () => {
    expect(stripPathPrefix('/n8n/', '/n8n/')).toBe('/');
    expect(stripPathPrefix('/n8n', '/n8n/')).toBe('/');
    expect(stripPathPrefix('/n8n/test', '/n8n/')).toBe('/test');
    expect(stripPathPrefix('/n8n/webhook/github', '/n8n/')).toBe('/webhook/github');
    expect(stripPathPrefix('/n8n/api/v1/test', '/n8n/')).toBe('/api/v1/test');
  });

  it('leaves non-matching paths untouched', () => {
    expect(stripPathPrefix('/n8next/thing', '/n8n/')).toBe('/n8next/thing');
    expect(stripPathPrefix('/other', '/n8n/')).toBe('/other');
  });

  it('is skipped when mapping is globally disabled', () => {
    expect(applyPathMapping('/n8n/test', mappedRoute, false)).toBe('/n8n/test');
    expect(applyPathMapping('/n8n/test', mappedRoute, true)).toBe('/test');
  });

  it('never applies to fallback', () => {
    expect(applyPathMapping('/unknown/path', fallbackRoute, true)).toBe('/unknown/path');
  });

  it('passes the path through when a route defines no mapping', () => {
    const plain: NormalRoute = { ...mappedRoute };
    delete (plain as { mapping?: unknown }).mapping;
    expect(applyPathMapping('/n8n/test', plain, true)).toBe('/n8n/test');
  });
});

describe('proxy headers', () => {
  const context = {
    peerIp: '10.0.0.5',
    protocol: 'http',
    host: 'gateway.example.com',
    requestId: 'req-1',
    trustProxy: true,
  };

  it('drops routing and hop-by-hop headers', () => {
    const headers = buildUpstreamHeaders(
      {
        'x-target': 'n8n',
        authorization: 'Bearer secret',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        host: 'gateway.example.com',
        'content-type': 'application/json',
        'x-custom': 'test',
      },
      context,
    );

    expect(headers['x-target']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
    expect(headers['connection']).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers['upgrade']).toBeUndefined();
    expect(headers['host']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-custom']).toBe('test');
  });

  it('drops client-supplied identity headers', () => {
    const headers = buildUpstreamHeaders(
      {
        'x-real-ip': '9.9.9.9',
        'x-webauth-user': 'admin',
        'x-forwarded-user': 'admin',
        'remote-user': 'admin',
        'remote-groups': 'admins',
        'x-auth-request-email': 'admin@corp',
        'x-auth-request-groups': 'admins',
        'x-custom': 'kept',
      },
      context,
    );

    expect(headers['x-real-ip']).toBeUndefined();
    expect(headers['x-webauth-user']).toBeUndefined();
    expect(headers['x-forwarded-user']).toBeUndefined();
    expect(headers['remote-user']).toBeUndefined();
    expect(headers['remote-groups']).toBeUndefined();
    expect(headers['x-auth-request-email']).toBeUndefined();
    expect(headers['x-auth-request-groups']).toBeUndefined();
    // Only the identity family is dropped; ordinary headers still pass.
    expect(headers['x-custom']).toBe('kept');
  });

  it('appends the socket peer once, without duplicating it', () => {
    const headers = buildUpstreamHeaders({ 'x-forwarded-for': '203.0.113.9' }, context);
    expect(headers['x-forwarded-for']).toBe('203.0.113.9, 10.0.0.5');
  });

  it('maintains the forwarding chain', () => {
    const headers = buildUpstreamHeaders({ 'x-forwarded-for': '203.0.113.9' }, context);
    expect(headers['x-forwarded-for']).toBe('203.0.113.9, 10.0.0.5');
    expect(headers['x-forwarded-proto']).toBe('http');
    expect(headers['x-forwarded-host']).toBe('gateway.example.com');
    expect(headers['x-request-id']).toBe('req-1');
  });

  it('ignores client-supplied forwarding headers when the proxy is untrusted', () => {
    const headers = buildUpstreamHeaders(
      { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
      { ...context, trustProxy: false },
    );
    expect(headers['x-forwarded-for']).toBe('10.0.0.5');
    expect(headers['x-forwarded-proto']).toBe('http');
  });

  it('filters hop-by-hop headers out of upstream responses', () => {
    const headers = buildDownstreamHeaders({
      'content-type': 'text/plain',
      connection: 'close',
      'transfer-encoding': 'chunked',
      'set-cookie': ['a=1', 'b=2'],
    });

    expect(headers['content-type']).toBe('text/plain');
    expect(headers['connection']).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers['set-cookie']).toEqual(['a=1', 'b=2']);
  });
});
