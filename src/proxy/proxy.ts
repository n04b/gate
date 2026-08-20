import type { Readable } from 'node:stream';
import { Agent, type Dispatcher } from 'undici';
import type { ServiceConfig } from '../config/types.js';
import { GateError } from '../routing/errors.js';
import { noAccessCredentials, type AccessCredentials } from './accessCredentials.js';
import { BodyTooLargeError } from './bodyLimit.js';

export interface ProxyForwardInput {
  readonly service: ServiceConfig;
  readonly method: string;
  /** Upstream path including the query string. */
  readonly path: string;
  readonly headers: Record<string, string | string[]>;
  readonly body: Readable | undefined;
}

export interface ProxyForwardResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Readable;
}

export interface Proxy {
  forward(input: ProxyForwardInput): Promise<ProxyForwardResult>;
  close(): Promise<void>;
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** `CF-Access-Client-Id` / `-Secret` — see `accessCredentials.ts` and SPEC §66. */
const ACCESS_CLIENT_ID_HEADER = 'cf-access-client-id';
const ACCESS_CLIENT_SECRET_HEADER = 'cf-access-client-secret';

/**
 * TLS options for outbound connections.
 *
 * Cloudflare origins present publicly trusted certificates, so this is unset in
 * production. It exists so tests can pin a throwaway CA to exercise the real
 * TLS path, and so a private CA is not a dead end.
 */
export interface ProxyTlsOptions {
  readonly ca?: string | readonly string[];
}

export interface CreateProxyOptions {
  /** Default timeout, used by any service that does not set its own. */
  readonly upstreamTimeoutMs: number;
  /** Cloudflare Access service tokens, keyed by service name. */
  readonly credentials?: AccessCredentials;
  readonly tls?: ProxyTlsOptions;
}

export function createProxy(options: CreateProxyOptions): Proxy {
  const credentials = options.credentials ?? noAccessCredentials;
  // A PEM is a string; spreading one would hand undici a list of characters.
  const ca = typeof options.tls?.ca === 'string' ? [options.tls.ca] : options.tls?.ca?.slice();

  // undici takes the connect timeout per Agent rather than per request, and for
  // an origin on the public internet the connect phase (DNS, TCP, TLS) is
  // exactly where the extra latency lives. One Agent per distinct timeout keeps
  // every phase on the same budget; in practice there are one or two.
  const agents = new Map<number, Agent>();
  const agentFor = (timeoutMs: number): Agent => {
    let agent = agents.get(timeoutMs);
    if (agent === undefined) {
      agent = new Agent({
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        connect: { timeout: timeoutMs, ...(ca === undefined ? {} : { ca }) },
      });
      agents.set(timeoutMs, agent);
    }
    return agent;
  };

  return {
    async forward(input: ProxyForwardInput): Promise<ProxyForwardResult> {
      const agent = agentFor(input.service.timeoutMs ?? options.upstreamTimeoutMs);

      try {
        // Redirects are never followed: the upstream response, including a 3xx,
        // is proxied back to the client verbatim.
        const response = await agent.request({
          origin: input.service.origin,
          path: input.path,
          method: input.method as Dispatcher.HttpMethod,
          headers: withAccessCredentials(input.headers, input.service, credentials),
          ...(input.body === undefined ? {} : { body: input.body }),
        });

        return {
          statusCode: response.statusCode,
          headers: response.headers as Record<string, string | string[] | undefined>,
          body: response.body as unknown as Readable,
        };
      } catch (error) {
        throw translateUpstreamError(error, input.service);
      }
    },

    async close(): Promise<void> {
      await Promise.all([...agents.values()].map((agent) => agent.close()));
    },
  };
}

/**
 * Adds the service token for this origin, when one is configured.
 *
 * Injection happens here rather than in `buildUpstreamHeaders` so that the
 * header builder stays a pure function with no access to secrets. A client
 * cannot pre-empt these values: `buildUpstreamHeaders` drops every inbound
 * `cf-access-*` header before the request reaches this point.
 */
function withAccessCredentials(
  headers: Record<string, string | string[]>,
  service: ServiceConfig,
  credentials: AccessCredentials,
): Record<string, string | string[]> {
  const credential = credentials.get(service.name);
  if (credential === undefined) return headers;

  return {
    ...headers,
    [ACCESS_CLIENT_ID_HEADER]: credential.clientId,
    [ACCESS_CLIENT_SECRET_HEADER]: credential.clientSecret,
  };
}

function translateUpstreamError(error: unknown, service: ServiceConfig): GateError {
  if (isBodyTooLarge(error)) {
    return GateError.payloadTooLarge();
  }

  const code = (error as { code?: string } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (code !== undefined && TIMEOUT_CODES.has(code)) {
    return GateError.gatewayTimeout(`${service.name}: ${message}`);
  }

  return GateError.badGateway(`${service.name}: ${message}`);
}

function isBodyTooLarge(error: unknown): boolean {
  if (error instanceof BodyTooLargeError) return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return cause instanceof BodyTooLargeError;
}
