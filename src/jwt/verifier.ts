import type { KeyObject } from 'node:crypto';
import { jwtVerify, type JWTPayload } from 'jose';
import type { JwtConfig } from '../config/types.js';
import { loadPublicKey } from './keys.js';

export interface VerifiedToken {
  readonly payload: JWTPayload;
  readonly subject: string | undefined;
  readonly jti: string | undefined;
  /** `target` claim as present in the token, `undefined` when absent. */
  readonly target: string | undefined;
}

export type VerifyFailureReason = 'malformed' | 'invalid' | 'revoked';

export type VerifyResult =
  | { readonly ok: true; readonly token: VerifiedToken }
  | { readonly ok: false; readonly reason: VerifyFailureReason; readonly detail: string };

/**
 * Future JWT revocation (SPEC §60) plugs in here: an implementation backed by a
 * revocation list is passed to the verifier without touching call sites.
 */
export interface RevocationChecker {
  isRevoked(jti: string | undefined): Promise<boolean> | boolean;
}

export const allowAllRevocationChecker: RevocationChecker = {
  isRevoked: () => false,
};

export interface JwtVerifier {
  /** Verifies a bare JWT (no `Bearer ` prefix). */
  verify(token: string): Promise<VerifyResult>;
}

export function createJwtVerifier(
  config: JwtConfig,
  options: { publicKey?: KeyObject; revocation?: RevocationChecker } = {},
): JwtVerifier {
  const publicKey = options.publicKey ?? loadPublicKey(config.publicKeyPath);
  const revocation = options.revocation ?? allowAllRevocationChecker;

  return {
    async verify(token: string): Promise<VerifyResult> {
      if (token.trim() === '') {
        return { ok: false, reason: 'malformed', detail: 'empty token' };
      }

      let payload: JWTPayload;
      try {
        // The expected algorithm is pinned by configuration; the `alg` header of
        // the token itself is never trusted (SPEC §27).
        const verified = await jwtVerify(token, publicKey, {
          algorithms: [config.algorithm],
          issuer: config.issuer,
          audience: [...config.audience],
          clockTolerance: config.clockToleranceSec,
        });
        payload = verified.payload;
      } catch (error) {
        return { ok: false, reason: 'invalid', detail: (error as Error).message };
      }

      if (await revocation.isRevoked(payload.jti)) {
        return { ok: false, reason: 'revoked', detail: 'token has been revoked' };
      }

      const rawTarget = payload['target'];
      const target =
        typeof rawTarget === 'string' && rawTarget.trim() !== '' ? rawTarget.trim() : undefined;

      return {
        ok: true,
        token: {
          payload,
          subject: payload.sub,
          jti: payload.jti,
          target,
        },
      };
    },
  };
}

/** Extracts the bare token from an `Authorization` header value. */
export function extractBearerToken(headerValue: string): string | undefined {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(headerValue);
  return match?.[1];
}
