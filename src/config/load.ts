import { readFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { resolve as resolvePath, dirname, isAbsolute } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  rawAccessSchema,
  rawConfigSchema,
  rawFallbackRouteSchema,
  rawNormalRouteSchema,
} from './schema.js';
import { parseDuration, parseSize, UnitParseError } from './units.js';
import type {
  AccessCredentialConfig,
  AccessSecretSource,
  FallbackRoute,
  GateConfig,
  JwtAlgorithm,
  NormalRoute,
  RouteMappingConfig,
  ServiceConfig,
} from './types.js';

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const ALLOWED_ALGORITHMS: readonly JwtAlgorithm[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
];

/** A target is a logical identifier — never a URL (SPEC §18). */
export const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const DEFAULTS = {
  host: '0.0.0.0',
  port: 6473,
  maxBodySize: '1MB',
  upstreamTimeout: '30s',
  trustProxy: false,
  algorithm: 'RS256' as JwtAlgorithm,
  issuer: 'homelab-gateway',
  audience: ['homelab'],
  clockToleranceSec: 5,
  requireExpiry: true,
  mappingEnabled: true,
  logLevel: 'info' as const,
  tokenLogPath: '/data/tokens.jsonl',
} as const;

/** Only used to keep validation going after an unparsable `services.*.timeout`. */
const DEFAULT_SERVICE_TIMEOUT_MS = 30_000;

export interface LoadOptions {
  /** Verify that the JWT key files exist and are readable. */
  readonly checkKeyFiles?: boolean;
  /** Base directory used to resolve relative paths inside the config file. */
  readonly baseDir?: string;
  /** Default `issued_by`, normally `process.env.GATE_ISSUED_BY`. */
  readonly defaultIssuedBy?: string | undefined;
}

export function loadConfigFile(path: string, options: LoadOptions = {}): GateConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError([`cannot read config file ${path}: ${(error as Error).message}`]);
  }
  return parseConfig(text, { baseDir: dirname(resolvePath(path)), ...options });
}

export function parseConfig(text: string, options: LoadOptions = {}): GateConfig {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    throw new ConfigError([`YAML syntax error: ${(error as Error).message}`]);
  }

  if (doc === null || doc === undefined) {
    throw new ConfigError(['configuration file is empty']);
  }

  const parsed = rawConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new ConfigError(formatZodIssues(parsed.error));
  }

  return buildConfig(parsed.data, options);
}

function buildConfig(raw: z.infer<typeof rawConfigSchema>, options: LoadOptions): GateConfig {
  const issues: string[] = [];
  const baseDir = options.baseDir ?? process.cwd();
  const checkKeyFiles = options.checkKeyFiles ?? true;

  // ---------------------------------------------------------------- services
  const services = new Map<string, ServiceConfig>();
  for (const [name, service] of Object.entries(raw.services)) {
    const label = `services.${name}`;
    const parsedUrl = parseServiceUrl(service.url);
    if (typeof parsedUrl === 'string') {
      issues.push(`${label}: ${parsedUrl}`);
      continue;
    }

    const access = buildAccessCredentials(service.access, label, baseDir, issues);

    // A service token on a plaintext hop is a credential on the wire. Every
    // origin behind Cloudflare Access is reachable over https, so requiring it
    // costs nothing and closes the mistake off entirely.
    if (access !== undefined && !parsedUrl.tls) {
      issues.push(
        `${label}: access requires an https:// url — a Cloudflare Access ` +
          'service token must never be sent over plaintext http',
      );
    }

    const timeoutMs =
      service.timeout === undefined
        ? undefined
        : numeric(
            () => parseDuration(service.timeout as string | number),
            `${label}.timeout`,
            issues,
            DEFAULT_SERVICE_TIMEOUT_MS,
          );

    services.set(name, {
      name,
      origin: parsedUrl.origin,
      basePath: parsedUrl.basePath,
      tls: parsedUrl.tls,
      ...(access === undefined ? {} : { access }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }
  if (Object.keys(raw.services).length === 0) {
    issues.push('services: at least one service must be defined');
  }

  // ------------------------------------------------------------------ routes
  const normalRoutes: NormalRoute[] = [];
  const fallbacks: FallbackRoute[] = [];
  const seenTargets = new Map<string, string>();

  if (raw.routes.length === 0) {
    issues.push('routes: at least one route must be defined');
  }

  raw.routes.forEach((item, index) => {
    const label = `routes[${index}]`;

    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`${label}: must be an object`);
      return;
    }

    const record = item as Record<string, unknown>;

    if ('fallback' in record) {
      buildFallbackRoute(record, label, services, issues, fallbacks);
      return;
    }

    if ('name' in record) {
      issues.push(`${label}: routes do not have a "name" field, use "target"`);
      return;
    }

    const route = rawNormalRouteSchema.safeParse(record);
    if (!route.success) {
      issues.push(...formatZodIssues(route.error, label));
      return;
    }

    const { target } = route.data;
    if (!TARGET_PATTERN.test(target)) {
      issues.push(
        `${label}: target "${target}" is not a valid identifier (a target is never a URL)`,
      );
      return;
    }

    const targetKey = target.toLowerCase();
    const previous = seenTargets.get(targetKey);
    if (previous !== undefined) {
      issues.push(`${label}: duplicate target "${target}" (already defined as "${previous}")`);
      return;
    }
    seenTargets.set(targetKey, target);

    const serviceName = route.data.service ?? target;
    const service = services.get(serviceName);
    if (service === undefined) {
      issues.push(`${label}: unknown service "${serviceName}"`);
      return;
    }

    const mapping = buildRouteMapping(route.data.mapping, label, issues);

    normalRoutes.push({
      kind: 'normal',
      target,
      targetKey,
      service,
      auth: route.data.auth ?? true,
      ...(mapping === undefined ? {} : { mapping }),
    });
  });

  // The fallback route is optional (SPEC §7). At most one may be defined:
  // without it, unresolved requests are rejected instead of proxied.
  if (fallbacks.length > 1) {
    issues.push(`routes: at most one fallback route is allowed, found ${fallbacks.length}`);
  }

  // --------------------------------------------------------------------- jwt
  const algorithmName = raw.jwt.algorithm ?? DEFAULTS.algorithm;
  const algorithm = ALLOWED_ALGORITHMS.find((a) => a === algorithmName);
  if (algorithm === undefined) {
    issues.push(
      `jwt.algorithm: "${algorithmName}" is not supported; ` +
        `use one of ${ALLOWED_ALGORITHMS.join(', ')} (symmetric algorithms and "none" are rejected)`,
    );
  }

  const publicKeyPath = resolveConfigPath(raw.jwt.public_key, baseDir);
  const privateKeyPath = resolveConfigPath(raw.jwt.private_key, baseDir);
  if (checkKeyFiles) {
    for (const [field, keyPath] of [
      ['jwt.public_key', publicKeyPath],
      ['jwt.private_key', privateKeyPath],
    ] as const) {
      try {
        accessSync(keyPath, fsConstants.R_OK);
      } catch {
        issues.push(`${field}: key file is missing or not readable: ${keyPath}`);
      }
    }
  }

  const audience =
    raw.jwt.audience === undefined
      ? [...DEFAULTS.audience]
      : typeof raw.jwt.audience === 'string'
        ? [raw.jwt.audience]
        : [...raw.jwt.audience];

  const clockToleranceSec = numeric(
    () =>
      raw.jwt.clock_tolerance === undefined
        ? DEFAULTS.clockToleranceSec
        : Math.round(parseDuration(raw.jwt.clock_tolerance) / 1000),
    'jwt.clock_tolerance',
    issues,
    DEFAULTS.clockToleranceSec,
  );

  // ------------------------------------------------------------------ server
  const maxBodySizeBytes = numeric(
    () => parseSize(raw.server?.max_body_size ?? DEFAULTS.maxBodySize),
    'server.max_body_size',
    issues,
    1024 * 1024,
  );
  const upstreamTimeoutMs = numeric(
    () => parseDuration(raw.server?.upstream_timeout ?? DEFAULTS.upstreamTimeout),
    'server.upstream_timeout',
    issues,
    30_000,
  );

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  const fallback = fallbacks[0];

  return {
    server: {
      host: raw.server?.host ?? DEFAULTS.host,
      port: raw.server?.port ?? DEFAULTS.port,
      maxBodySizeBytes,
      upstreamTimeoutMs,
      trustProxy: raw.server?.trust_proxy ?? DEFAULTS.trustProxy,
    },
    jwt: {
      algorithm: algorithm as JwtAlgorithm,
      publicKeyPath,
      privateKeyPath,
      issuer: raw.jwt.issuer ?? DEFAULTS.issuer,
      audience,
      clockToleranceSec,
      requireExpiry: raw.jwt.require_expiry ?? DEFAULTS.requireExpiry,
    },
    mapping: { enabled: raw.mapping?.enabled ?? DEFAULTS.mappingEnabled },
    logging: { level: raw.logging?.level ?? DEFAULTS.logLevel },
    tokenLog: {
      path: resolveConfigPath(raw.token_log?.path ?? DEFAULTS.tokenLogPath, baseDir),
      // An empty GATE_ISSUED_BY is treated as unset, not as an empty issuer.
      defaultIssuedBy: raw.token_log?.issued_by ?? blankToUndefined(options.defaultIssuedBy),
    },
    services,
    routes: normalRoutes,
    fallback,
  };
}

function buildFallbackRoute(
  record: Record<string, unknown>,
  label: string,
  services: ReadonlyMap<string, ServiceConfig>,
  issues: string[],
  fallbacks: FallbackRoute[],
): void {
  const inner = record['fallback'];
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner) && 'auth' in inner) {
    issues.push(`${label}: fallback must not define "auth" (fallback never authenticates)`);
    return;
  }

  const parsed = rawFallbackRouteSchema.safeParse(record);
  if (!parsed.success) {
    issues.push(...formatZodIssues(parsed.error, label));
    return;
  }

  const service = services.get(parsed.data.fallback.service);
  if (service === undefined) {
    issues.push(`${label}: unknown service "${parsed.data.fallback.service}"`);
    return;
  }

  fallbacks.push({ kind: 'fallback', service, auth: false });
}

function buildRouteMapping(
  raw: { path?: { strip_prefix: string } | undefined } | undefined,
  label: string,
  issues: string[],
): RouteMappingConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw.path === undefined) return {};

  const stripPrefix = raw.path.strip_prefix;
  if (!stripPrefix.startsWith('/')) {
    issues.push(`${label}: mapping.path.strip_prefix must start with "/" (got "${stripPrefix}")`);
    return undefined;
  }
  if (stripPrefix.includes('?') || stripPrefix.includes('#')) {
    issues.push(`${label}: mapping.path.strip_prefix must not contain a query or fragment`);
    return undefined;
  }
  return { path: { stripPrefix } };
}

/**
 * Validates a Cloudflare Access service token reference.
 *
 * Only the *reference* is resolved here. The secret itself is read at startup
 * by `proxy/accessCredentials.ts` so that it never enters {@link GateConfig},
 * which Gate summarises to the log when it starts.
 */
function buildAccessCredentials(
  raw: z.infer<typeof rawAccessSchema> | undefined,
  label: string,
  baseDir: string,
  issues: string[],
): AccessCredentialConfig | undefined {
  if (raw === undefined) return undefined;

  const file = raw.client_secret_file;
  const env = raw.client_secret_env;

  if (file !== undefined && env !== undefined) {
    issues.push(
      `${label}: access must set exactly one of client_secret_file and client_secret_env, not both`,
    );
    return undefined;
  }

  const secret: AccessSecretSource | undefined =
    file !== undefined
      ? { kind: 'file', path: resolveConfigPath(file, baseDir) }
      : env !== undefined
        ? { kind: 'env', name: env }
        : undefined;

  if (secret === undefined) {
    issues.push(`${label}: access requires client_secret_file or client_secret_env`);
    return undefined;
  }

  return { clientId: raw.client_id, secret };
}

function parseServiceUrl(
  value: string,
): { origin: string; basePath: string; tls: boolean } | string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `invalid URL "${value}"`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `unsupported URL scheme "${url.protocol}" (only http and https are allowed)`;
  }
  if (url.search !== '' || url.hash !== '') {
    return `service URL must not contain a query string or fragment: "${value}"`;
  }
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return { origin: url.origin, basePath, tls: url.protocol === 'https:' };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function resolveConfigPath(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolvePath(baseDir, value);
}

function numeric(
  compute: () => number,
  field: string,
  issues: string[],
  fallbackValue: number,
): number {
  try {
    return compute();
  } catch (error) {
    if (error instanceof UnitParseError) {
      issues.push(`${field}: ${error.message}`);
      return fallbackValue;
    }
    throw error;
  }
}

function formatZodIssues(error: z.ZodError, prefix?: string): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    const location = [prefix, path].filter((part) => part !== undefined && part !== '').join('.');
    return location === '' ? issue.message : `${location}: ${issue.message}`;
  });
}
