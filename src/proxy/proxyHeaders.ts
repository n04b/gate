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

/**
 * Headers that some upstreams are configured to read as an already
 * authenticated identity — Grafana's `auth.proxy`, oauth2-proxy, and the
 * `remote-*` family used by several self-hosted apps.
 *
 * Gate is the authentication boundary, so a client must never be able to
 * assert one of these. They are dropped unconditionally: Gate does not issue
 * them today, and a request carrying one can only be trying to impersonate.
 */
const SPOOFABLE_IDENTITY_HEADERS = new Set([
  'x-real-ip',
  'x-forwarded-user',
  'x-forwarded-email',
  'x-forwarded-groups',
  'x-forwarded-preferred-username',
  'x-webauth-user',
  'x-webauth-name',
  'x-webauth-email',
  'x-authenticated-user',
  'remote-user',
  'remote-name',
  'remote-email',
  'remote-groups',
]);

/** The oauth2-proxy identity family: `x-auth-request-user`, `-email`, `-groups`… */
const IDENTITY_HEADER_PREFIX = 'x-auth-request-';

/**
 * The Cloudflare Access family, dropped from client requests unconditionally.
 *
 * Two distinct things live under this prefix and a client may assert neither:
 *
 * - `cf-access-client-id` / `cf-access-client-secret` are the service token
 *   Gate itself presents to an external origin (SPEC §66). Letting a client
 *   supply them would mean choosing the credential Gate authenticates with.
 * - `cf-access-jwt-assertion` and `cf-access-authenticated-user-email` are the
 *   identity Access asserts to an origin, which upstreams are configured to
 *   trust — the same impersonation class as the headers above.
 *
 * Other `cf-*` headers (`cf-connecting-ip`, `cf-ray`, `cf-ipcountry`) are
 * ordinary metadata and still pass through; the trustworthy client address is
 * carried by `x-forwarded-for`, which Gate rebuilds from the socket peer.
 */
const ACCESS_HEADER_PREFIX = 'cf-access-';

export interface ForwardHeaderContext {
  /**
   * Address of the socket peer. This is the only address a client cannot
   * forge, so it — never `request.ip` — is what Gate appends to the chain.
   */
  readonly peerIp: string | undefined;
  readonly protocol: string;
  readonly host: string | undefined;
  readonly requestId: string;
  /** `false` when no proxy is trusted; any other value trusts the peer. */
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
    if (SPOOFABLE_IDENTITY_HEADERS.has(lower)) continue;
    if (lower.startsWith(IDENTITY_HEADER_PREFIX)) continue;
    if (lower.startsWith(ACCESS_HEADER_PREFIX)) continue; // Gate's own, or Access's
    if (lower.startsWith('x-forwarded-')) continue; // rebuilt below
    headers[lower] = value;
  }

  // Each proxy appends the address it received the request from. Appending
  // `request.ip` instead would duplicate a value trustProxy just derived from
  // this very header, and would drop the real peer from the chain entirely.
  const forwardedFor = context.trustProxy
    ? joinForwardedFor(incoming['x-forwarded-for'], context.peerIp)
    : context.peerIp;
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
  peerIp: string | undefined,
): string | undefined {
  const chain = (Array.isArray(existing) ? existing.join(', ') : existing)?.trim();
  if (chain === undefined || chain === '') return peerIp;
  return peerIp === undefined ? chain : `${chain}, ${peerIp}`;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
