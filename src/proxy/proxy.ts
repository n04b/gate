import type { Readable } from 'node:stream';
import { Agent, type Dispatcher } from 'undici';
import type { ServiceConfig } from '../config/types.js';
import { GateError } from '../routing/errors.js';
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

export function createProxy(options: { upstreamTimeoutMs: number }): Proxy {
  const agent = new Agent({
    headersTimeout: options.upstreamTimeoutMs,
    bodyTimeout: options.upstreamTimeoutMs,
    connect: { timeout: options.upstreamTimeoutMs },
  });

  return {
    async forward(input: ProxyForwardInput): Promise<ProxyForwardResult> {
      try {
        // Redirects are never followed: the upstream response, including a 3xx,
        // is proxied back to the client verbatim.
        const response = await agent.request({
          origin: input.service.origin,
          path: input.path,
          method: input.method as Dispatcher.HttpMethod,
          headers: input.headers,
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
      await agent.close();
    },
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
