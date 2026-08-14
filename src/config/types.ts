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

export interface ServiceConfig {
  /** Key under `services:` in the YAML file. */
  readonly name: string;
  /** Origin of the upstream, e.g. `http://n8n:5678`. */
  readonly origin: string;
  /** Optional base path taken from the service URL, `''` when none. */
  readonly basePath: string;
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
  /** Trust `X-Forwarded-*` sent by the tunnel in front of Gate. */
  readonly trustProxy: boolean;
}

export interface JwtConfig {
  readonly algorithm: JwtAlgorithm;
  readonly publicKeyPath: string;
  readonly privateKeyPath: string;
  readonly issuer: string;
  readonly audience: readonly string[];
  /** Allowed clock skew when checking `exp` / `nbf`, in seconds. */
  readonly clockToleranceSec: number;
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
  readonly fallback: FallbackRoute;
}
