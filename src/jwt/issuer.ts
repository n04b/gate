import { randomBytes, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type { JwtConfig } from '../config/types.js';
import { loadPrivateKey } from './keys.js';

export interface IssueTokenInput {
  readonly subject: string;
  readonly target: string;
  /** Lifetime in milliseconds; omit for a non-expiring token. */
  readonly expiresInMs?: number | undefined;
  /** Overridable for deterministic tests. */
  readonly now?: Date;
  readonly jti?: string;
}

export interface IssuedToken {
  readonly token: string;
  readonly jti: string;
  readonly subject: string;
  readonly target: string;
  readonly issuedAt: number;
  readonly expiresAt: number | undefined;
}

export interface TokenIssuer {
  issue(input: IssueTokenInput): Promise<IssuedToken>;
}

export function createTokenIssuer(
  config: JwtConfig,
  options: { privateKey?: KeyObject } = {},
): TokenIssuer {
  const privateKey = options.privateKey ?? loadPrivateKey(config.privateKeyPath);
  const audience = config.audience.length === 1 ? (config.audience[0] as string) : [...config.audience];

  return {
    async issue(input: IssueTokenInput): Promise<IssuedToken> {
      const now = input.now ?? new Date();
      const iat = Math.floor(now.getTime() / 1000);
      const jti = input.jti ?? randomBytes(8).toString('hex');
      const exp =
        input.expiresInMs === undefined ? undefined : iat + Math.floor(input.expiresInMs / 1000);

      let builder = new SignJWT({ target: input.target })
        .setProtectedHeader({ alg: config.algorithm, typ: 'JWT' })
        .setIssuer(config.issuer)
        .setAudience(audience)
        .setSubject(input.subject)
        .setIssuedAt(iat)
        .setJti(jti);

      if (exp !== undefined) {
        builder = builder.setExpirationTime(exp);
      }

      return {
        token: await builder.sign(privateKey),
        jti,
        subject: input.subject,
        target: input.target,
        issuedAt: iat,
        expiresAt: exp,
      };
    },
  };
}
