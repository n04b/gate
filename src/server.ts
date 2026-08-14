import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { GateConfig, Route } from './config/types.js';
import { createJwtVerifier, type JwtVerifier } from './jwt/verifier.js';
import { createProxy, type Proxy } from './proxy/proxy.js';
import { applyPathMapping } from './proxy/mapping.js';
import { declaredLengthExceeds, limitBodyStream } from './proxy/bodyLimit.js';
import { buildDownstreamHeaders, buildUpstreamHeaders } from './proxy/proxyHeaders.js';
import { GateError } from './routing/errors.js';
import { createRouteTable, type RouteTable } from './routing/routeTable.js';
import { resolveTarget } from './routing/targetResolver.js';

export interface BuildServerOptions {
  readonly config: GateConfig;
  /** Injectable for tests; built from the configured public key otherwise. */
  readonly verifier?: JwtVerifier;
  readonly proxy?: Proxy;
}

interface RequestContext {
  target: string | undefined;
  targetSource: string | undefined;
  service: string | undefined;
  route: 'normal' | 'fallback' | 'none';
  upstreamPath: string | undefined;
  startedAt: bigint;
}

declare module 'fastify' {
  interface FastifyRequest {
    gate: RequestContext;
  }
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config } = options;
  const verifier = options.verifier ?? createJwtVerifier(config.jwt);
  const proxy = options.proxy ?? createProxy({ upstreamTimeoutMs: config.server.upstreamTimeoutMs });
  const routeTable: RouteTable = createRouteTable(config);

  const app = Fastify({
    logger: {
      level: config.logging.level,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization'],
        remove: true,
      },
    },
    // Gate emits its own single-line request log in the onResponse hook.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'request_id',
    }),
    trustProxy: config.server.trustProxy,
    genReqId: () => randomUUID(),
    // The body is streamed straight upstream; the limit is enforced by
    // limitBodyStream, not by Fastify's parser.
    bodyLimit: config.server.maxBodySizeBytes,
  });

  // Never parse or buffer request bodies — Gate proxies them verbatim.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, _payload, done) => {
    done(null, undefined);
  });

  app.decorateRequest('gate');

  app.addHook('onRequest', async (request) => {
    request.gate = {
      target: undefined,
      targetSource: undefined,
      service: undefined,
      route: 'none',
      upstreamPath: undefined,
      startedAt: process.hrtime.bigint(),
    };
  });

  app.addHook('onResponse', async (request, reply) => {
    const context = request.gate;
    const durationMs = Number(process.hrtime.bigint() - context.startedAt) / 1e6;
    request.log.info(
      {
        target: context.target ?? null,
        target_source: context.targetSource ?? null,
        service: context.service ?? null,
        route: context.route,
        method: request.method,
        path: request.url,
        upstream_path: context.upstreamPath ?? null,
        status: reply.statusCode,
        duration_ms: Number(durationMs.toFixed(3)),
      },
      'request',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const gateError =
      error instanceof GateError
        ? error
        : new GateError(
            'internal_error',
            500,
            error instanceof Error ? error.message : String(error),
          );

    if (gateError.statusCode >= 500) {
      request.log.error({ code: gateError.code, detail: gateError.detail }, 'request failed');
    } else {
      request.log.warn({ code: gateError.code, detail: gateError.detail }, 'request rejected');
    }

    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }

    reply.status(gateError.statusCode).send({ error: gateError.code });
  });

  // /health is answered by Gate itself: no target, no JWT, never proxied.
  app.get('/health', async () => ({ status: 'ok' }));

  app.all('/*', gatewayHandler);
  app.all('/', gatewayHandler);

  // Reached only when a static route exists for the path but not for the method
  // (e.g. POST /health). Such requests are routed like any other request rather
  // than answered with Fastify's own 404 body.
  app.setNotFoundHandler(gatewayHandler);

  app.addHook('onClose', async () => {
    await proxy.close();
  });

  async function gatewayHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = request.gate;
    const [path, query] = splitUrl(request.url);

    const resolution = await resolveTarget(request.headers, verifier);
    context.target = resolution.target;
    context.targetSource = resolution.source;

    let route: Route = routeTable.fallback;
    if (resolution.target !== undefined) {
      const matched = routeTable.match({
        target: resolution.target,
        method: request.method,
        path,
        token: resolution.token,
      });
      if (matched !== undefined) route = matched;
    }
    context.route = route.kind;
    context.service = route.service.name;

    // Once a normal route is selected the request never falls back: an auth
    // failure is an error, not a reroute (SPEC §15).
    if (route.kind === 'normal' && route.auth && resolution.token === undefined) {
      throw GateError.unauthorized('route requires authentication but no JWT was presented');
    }

    if (declaredLengthExceeds(request.headers['content-length'], config.server.maxBodySizeBytes)) {
      throw GateError.payloadTooLarge();
    }

    const mappedPath = applyPathMapping(path, route, config.mapping.enabled);
    const upstreamPath = `${route.service.basePath}${mappedPath}${query === undefined ? '' : `?${query}`}`;
    context.upstreamPath = upstreamPath;

    const headers = buildUpstreamHeaders(request.headers, {
      clientIp: request.ip,
      protocol: request.protocol,
      host: request.headers.host,
      requestId: String(request.id),
      trustProxy: config.server.trustProxy,
    });

    const body = hasRequestBody(request)
      ? limitBodyStream(request.raw as unknown as Readable, config.server.maxBodySizeBytes)
      : undefined;

    const upstream = await proxy.forward({
      service: route.service,
      method: request.method,
      path: upstreamPath,
      headers,
      body,
    });

    await reply
      .status(upstream.statusCode)
      .headers(buildDownstreamHeaders(upstream.headers))
      .send(upstream.body);
  }

  return app;
}

function splitUrl(url: string): [string, string | undefined] {
  const index = url.indexOf('?');
  if (index === -1) return [url, undefined];
  return [url.slice(0, index), url.slice(index + 1)];
}

function hasRequestBody(request: FastifyRequest): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;

  const contentLength = request.headers['content-length'];
  const transferEncoding = request.headers['transfer-encoding'];
  if (contentLength === undefined && transferEncoding === undefined) return false;
  if (contentLength !== undefined && Number(contentLength) === 0) return false;
  return true;
}
