import type { IncomingHttpHeaders } from 'node:http';

/**
 * Hop-by-hop headers must not be forwarded in either direction (SPEC §51).
 *
 * `connection` / `upgrade` are dropped here, so an upgrade request degrades to
 * a plain HTTP request — WebSocket proxying (SPEC §60) would be handled before
 * this point, on the server's `upgrade` event, rather than by forwarding them.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers Gate consumes itself and never passes upstream. */
const GATE_ONLY_REQUEST_HEADERS = new Set(['x-target', 'authorization', 'host', 'expect']);

export interface ForwardHeaderContext {
  readonly clientIp: string | undefined;
  readonly protocol: string;
  readonly host: string | undefined;
  readonly requestId: string;
  readonly trustProxy: boolean;
}

export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  context: ForwardHeaderContext,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};

  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (GATE_ONLY_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith('x-forwarded-')) continue; // rebuilt below
    headers[lower] = value;
  }

  const forwardedFor = context.trustProxy
    ? joinForwardedFor(incoming['x-forwarded-for'], context.clientIp)
    : context.clientIp;
  if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor;

  const forwardedProto = context.trustProxy
    ? firstValue(incoming['x-forwarded-proto']) ?? context.protocol
    : context.protocol;
  headers['x-forwarded-proto'] = forwardedProto;

  const forwardedHost = context.trustProxy
    ? firstValue(incoming['x-forwarded-host']) ?? context.host
    : context.host;
  if (forwardedHost !== undefined) headers['x-forwarded-host'] = forwardedHost;

  headers['x-request-id'] = context.requestId;

  return headers;
}

/** Filters an upstream response before it is proxied back to the client. */
export function buildDownstreamHeaders(
  upstream: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    headers[lower] = value;
  }
  return headers;
}

function joinForwardedFor(
  existing: string | string[] | undefined,
  clientIp: string | undefined,
): string | undefined {
  const chain = (Array.isArray(existing) ? existing.join(', ') : existing)?.trim();
  if (chain === undefined || chain === '') return clientIp;
  return clientIp === undefined ? chain : `${chain}, ${clientIp}`;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
