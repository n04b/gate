/** Resolved (post-validation) configuration model used across Gate. */

export type JwtAlgorithm =
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512';

/**
 * Where the `CF-Access-Client-Secret` value is read from at startup.
 *
 * The secret is deliberately not expressible inline: `config/gate.yaml` is a
 * bind-mounted file an operator is told to edit, so it is the wrong place for a
 * credential. It is resolved outside {@link GateConfig} (see
 * `proxy/accessCredentials.ts`) and never becomes part of the config object
 * that Gate logs at startup.
 */
export type AccessSecretSource =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'env'; readonly name: string };

/**
 * A Cloudflare Access service token Gate presents to an external origin
 * (a Worker, or anything else behind Access) as `CF-Access-Client-Id` /
 * `CF-Access-Client-Secret`.
 */
export interface AccessCredentialConfig {
  /** `CF-Access-Client-Id`. A public identifier, not a secret. */
  readonly clientId: string;
  readonly secret: AccessSecretSource;
}

export interface ServiceConfig {
  /** Key under `services:` in the YAML file. */
  readonly name: string;
  /** Origin of the upstream, e.g. `http://n8n:5678`. */
  readonly origin: string;
  /** Optional base path taken from the service URL, `''` when none. */
  readonly basePath: string;
  /** True when the origin is reached over TLS. Required for {@link access}. */
  readonly tls?: boolean;
  /** Outbound Cloudflare Access credentials, when the origin requires them. */
  readonly access?: AccessCredentialConfig;
  /**
   * Per-service egress timeout, overriding `server.upstream_timeout`. An
   * origin on the public internet has a different failure profile from a
   * container on the `services` network, so it gets its own budget.
   */
  readonly timeoutMs?: number;
}

export interface PathMappingConfig {
  readonly stripPrefix: string;
}

export interface RouteMappingConfig {
  readonly path?: PathMappingConfig;
}

export interface NormalRoute {
  readonly kind: 'normal';
  /** Target as written in the configuration. */
  readonly target: string;
  /** Lower-cased target, used for case-insensitive lookup. */
  readonly targetKey: string;
  readonly service: ServiceConfig;
  readonly auth: boolean;
  readonly mapping?: RouteMappingConfig;
}

export interface FallbackRoute {
  readonly kind: 'fallback';
  readonly service: ServiceConfig;
  /** Fallback never authenticates and never maps paths. */
  readonly auth: false;
}

export type Route = NormalRoute | FallbackRoute;

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodySizeBytes: number;
  readonly upstreamTimeoutMs: number;
  /**
   * Which peers may set `X-Forwarded-*`. `false` trusts none; a string is an
   * IP/CIDR (or comma-separated list) and a number is a hop count, both passed
   * to Fastify unchanged. `true` trusts every peer and is not the default.
   */
  readonly trustProxy: boolean | string | number;
}

export interface JwtConfig {
  readonly algorithm: JwtAlgorithm;
  readonly publicKeyPath: string;
  readonly privateKeyPath: string;
  readonly issuer: string;
  readonly audience: readonly string[];
  /** Allowed clock skew when checking `exp` / `nbf`, in seconds. */
  readonly clockToleranceSec: number;
  /**
   * Reject tokens with no `exp` claim. On by default: an expiry-less token
   * cannot be revoked, since Gate has no revocation list (SPEC §60).
   */
  readonly requireExpiry: boolean;
}

export interface TokenLogConfig {
  readonly path: string;
  readonly defaultIssuedBy: string | undefined;
}

export interface LoggingConfig {
  readonly level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export interface GateConfig {
  readonly server: ServerConfig;
  readonly jwt: JwtConfig;
  readonly mapping: { readonly enabled: boolean };
  readonly logging: LoggingConfig;
  readonly tokenLog: TokenLogConfig;
  readonly services: ReadonlyMap<string, ServiceConfig>;
  readonly routes: readonly NormalRoute[];
  /**
   * The fallback route, or `undefined` when none is configured. Without a
   * fallback, a request that resolves no matching route is rejected rather
   * than proxied (SPEC §14): `no_target` (400) when no target could be
   * resolved at all, `no_route` (404) when a target resolved but no route
   * matched it.
   */
  readonly fallback: FallbackRoute | undefined;
}
