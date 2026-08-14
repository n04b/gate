import { beforeAll, describe, expect, it } from 'vitest';
import { createSecretKey, createPublicKey, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { parseConfig } from '../src/config/load.js';
import { createJwtVerifier, extractBearerToken } from '../src/jwt/verifier.js';
import { createTokenIssuer } from '../src/jwt/issuer.js';
import type { GateConfig } from '../src/config/types.js';
import { createTestKeys, type TestKeys } from './helpers.js';

let keys: TestKeys;
let config: GateConfig;

beforeAll(() => {
  keys = createTestKeys();
  config = parseConfig(`
jwt:
  public_key: ${keys.publicKeyPath}
  private_key: ${keys.privateKeyPath}
services:
  fallback:
    url: http://fallback:8080
routes:
  - fallback:
      service: fallback
`);
});

function privateKey() {
  return createPrivateKey(readFileSync(keys.privateKeyPath, 'utf8'));
}

async function signRaw(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256' },
): Promise<string> {
  return new SignJWT(payload).setProtectedHeader(header as never).sign(privateKey());
}

describe('token issuing', () => {
  it('produces every required claim', async () => {
    const issuer = createTokenIssuer(config.jwt);
    const issued = await issuer.issue({ subject: 'github', target: 'n8n', expiresInMs: 3_600_000 });

    const verifier = createJwtVerifier(config.jwt);
    const result = await verifier.verify(issued.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { payload } = result.token;
    expect(payload.iss).toBe('homelab-gateway');
    expect(payload.aud).toBe('homelab');
    expect(payload.sub).toBe('github');
    expect(payload['target']).toBe('n8n');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.jti).toBe('string');
    expect(payload.exp).toBe((payload.iat as number) + 3600);
  });

  it('omits exp for non-expiring tokens', async () => {
    const issued = await createTokenIssuer(config.jwt).issue({ subject: 'a', target: 'n8n' });
    expect(issued.expiresAt).toBeUndefined();

    const result = await createJwtVerifier(config.jwt).verify(issued.token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.payload.exp).toBeUndefined();
  });
});

describe('token verification', () => {
  it('rejects a token signed by a different key', async () => {
    const other = createTestKeys();
    const foreign = await createTokenIssuer({ ...config.jwt, privateKeyPath: other.privateKeyPath }).issue(
      { subject: 'a', target: 'n8n', expiresInMs: 60_000 },
    );

    const result = await createJwtVerifier(config.jwt).verify(foreign.token);
    expect(result.ok).toBe(false);
  });

  it('rejects alg: none', async () => {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    )}.${Buffer.from(
      JSON.stringify({ iss: 'homelab-gateway', aud: 'homelab', sub: 'a', target: 'n8n' }),
    ).toString('base64url')}.`;

    const result = await createJwtVerifier(config.jwt).verify(unsigned);
    expect(result.ok).toBe(false);
  });

  it('rejects HS256 signed with the RSA public key as secret (algorithm confusion)', async () => {
    const publicPem = readFileSync(keys.publicKeyPath, 'utf8');
    const secret = createSecretKey(Buffer.from(publicPem));
    const forged = await new SignJWT({ target: 'n8n' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('homelab-gateway')
      .setAudience('homelab')
      .setSubject('attacker')
      .setIssuedAt()
      .setJti('forged')
      .sign(secret);

    const result = await createJwtVerifier(config.jwt).verify(forged);
    expect(result.ok).toBe(false);
  });

  it('rejects expired tokens', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signRaw({
      iss: 'homelab-gateway',
      aud: 'homelab',
      sub: 'a',
      target: 'n8n',
      iat: past,
      exp: past + 60,
      jti: 'x',
    });

    const result = await createJwtVerifier(config.jwt).verify(token);
    expect(result.ok).toBe(false);
  });

  it('rejects not-yet-valid tokens', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = await signRaw({
      iss: 'homelab-gateway',
      aud: 'homelab',
      sub: 'a',
      target: 'n8n',
      iat: future,
      nbf: future,
      jti: 'x',
    });

    const result = await createJwtVerifier(config.jwt).verify(token);
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong issuer or audience', async () => {
    const base = { sub: 'a', target: 'n8n', iat: Math.floor(Date.now() / 1000), jti: 'x' };
    const verifier = createJwtVerifier(config.jwt);

    expect((await verifier.verify(await signRaw({ ...base, iss: 'someone-else', aud: 'homelab' }))).ok).toBe(
      false,
    );
    expect(
      (await verifier.verify(await signRaw({ ...base, iss: 'homelab-gateway', aud: 'elsewhere' }))).ok,
    ).toBe(false);
  });

  it('reports a missing target instead of failing verification', async () => {
    const token = await signRaw({
      iss: 'homelab-gateway',
      aud: 'homelab',
      sub: 'github',
      iat: Math.floor(Date.now() / 1000),
      jti: 'x',
    });

    const result = await createJwtVerifier(config.jwt).verify(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.target).toBeUndefined();
  });

  it('supports a pluggable revocation checker', async () => {
    const issued = await createTokenIssuer(config.jwt).issue({
      subject: 'a',
      target: 'n8n',
      expiresInMs: 60_000,
      jti: 'revoked-jti',
    });

    const verifier = createJwtVerifier(config.jwt, {
      publicKey: createPublicKey(readFileSync(keys.publicKeyPath, 'utf8')),
      revocation: { isRevoked: (jti) => jti === 'revoked-jti' },
    });

    const result = await verifier.verify(issued.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });
});

describe('extractBearerToken', () => {
  it('accepts any casing of the scheme', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('  BEARER   abc  ')).toBe('abc');
  });

  it('rejects other schemes', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(extractBearerToken('abc')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
  });
});
