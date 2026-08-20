import { readFileSync } from 'node:fs';
import type { AccessSecretSource, ServiceConfig } from '../config/types.js';

/**
 * Resolution of Cloudflare Access service tokens.
 *
 * Configuration only records *where* a secret lives (SPEC §66). The value is
 * read here, once, when the server is built — so it lives in the proxy and
 * never in {@link GateConfig}, which Gate summarises to its log at startup.
 */

export class AccessCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessCredentialError';
  }
}

export interface AccessCredential {
  /** Sent as `CF-Access-Client-Id`. */
  readonly clientId: string;
  /** Sent as `CF-Access-Client-Secret`. Never logged. */
  readonly clientSecret: string;
}

/** Resolved credentials keyed by service name. */
export type AccessCredentials = ReadonlyMap<string, AccessCredential>;

export const noAccessCredentials: AccessCredentials = new Map();

/**
 * Reads the service token for every service that configures one.
 *
 * Throws on the first unusable secret: a gateway that starts without the
 * credential it needs would answer every request to that service with a 502
 * from Access, which is far harder to diagnose than refusing to start.
 */
export function resolveAccessCredentials(
  services: Iterable<ServiceConfig>,
  env: NodeJS.ProcessEnv = process.env,
): AccessCredentials {
  const resolved = new Map<string, AccessCredential>();

  for (const service of services) {
    if (service.access === undefined) continue;
    resolved.set(service.name, {
      clientId: service.access.clientId,
      clientSecret: readSecret(service.access.secret, `services.${service.name}.access`, env),
    });
  }

  return resolved;
}

function readSecret(source: AccessSecretSource, label: string, env: NodeJS.ProcessEnv): string {
  const raw = source.kind === 'file' ? readSecretFile(source.path, label) : env[source.name];

  if (raw === undefined) {
    throw new AccessCredentialError(`${label}: ${describe(source)} is not set`);
  }

  // A secret written with `echo` carries a trailing newline, and a header value
  // containing CR or LF is a header-injection primitive rather than a
  // credential. Trim the whitespace, then reject anything still unprintable.
  const secret = raw.trim();
  if (secret === '') {
    throw new AccessCredentialError(`${label}: ${describe(source)} is empty`);
  }
  if (!/^[\x20-\x7e]+$/.test(secret)) {
    throw new AccessCredentialError(
      `${label}: ${describe(source)} contains characters that are not valid in a header value`,
    );
  }

  return secret;
}

function readSecretFile(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new AccessCredentialError(`${label}: cannot read ${path}: ${(error as Error).message}`);
  }
}

function describe(source: AccessSecretSource): string {
  return source.kind === 'file' ? source.path : `environment variable ${source.name}`;
}
