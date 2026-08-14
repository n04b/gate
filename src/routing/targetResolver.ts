import type { IncomingHttpHeaders } from 'node:http';
import type { JwtVerifier, VerifiedToken } from '../jwt/verifier.js';
import { extractBearerToken } from '../jwt/verifier.js';
import { GateError } from './errors.js';
import { lastHeaderValue, singleHeaderValue } from './headers.js';

/** Where a resolved target came from. Future sources (API key, path, query,
 *  static target — SPEC §61) extend this union and the resolver chain below. */
export type TargetSource = 'jwt' | 'header';

export interface TargetResolution {
  /** Resolved target, `undefined` when nothing could be resolved (→ fallback). */
  readonly target: string | undefined;
  readonly source: TargetSource | undefined;
  /** Set whenever a valid JWT was presented, regardless of the target source. */
  readonly token: VerifiedToken | undefined;
}

export const X_TARGET_HEADER = 'x-target';

/**
 * Resolves the routing target from a request (SPEC §9).
 *
 * Throws {@link GateError} for the two explicit JWT failure modes: an invalid
 * token (401) and a valid token without a `target` claim (400). Neither ever
 * falls through to `X-Target` or to the fallback route.
 */
export async function resolveTarget(
  headers: IncomingHttpHeaders,
  verifier: JwtVerifier,
): Promise<TargetResolution> {
  const authorization = singleHeaderValue(headers, 'authorization');

  if (authorization !== undefined) {
    const bearer = extractBearerToken(authorization);
    if (bearer === undefined) {
      throw GateError.jwtInvalid('authorization header is not a bearer token');
    }

    const result = await verifier.verify(bearer);
    if (!result.ok) {
      throw GateError.jwtInvalid(result.detail);
    }

    if (result.token.target === undefined) {
      throw GateError.jwtTargetMissing();
    }

    // A valid JWT wins over X-Target, which is ignored entirely (SPEC §10).
    return { target: result.token.target, source: 'jwt', token: result.token };
  }

  const headerTarget = lastHeaderValue(headers, X_TARGET_HEADER);
  if (headerTarget === undefined) {
    return { target: undefined, source: undefined, token: undefined };
  }

  return { target: headerTarget, source: 'header', token: undefined };
}
