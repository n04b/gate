#!/usr/bin/env node
import { hostname, userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveConfigPath } from './bootstrap.js';
import { ConfigError, loadConfigFile, TARGET_PATTERN } from './config/load.js';
import { parseDuration, UnitParseError } from './config/units.js';
import { createTokenIssuer } from './jwt/issuer.js';
import { KeyLoadError } from './jwt/keys.js';
import { appendRevocation } from './jwt/revocation.js';
import { appendTokenLog, tokenLogHasJti } from './tokenlog/log.js';

const DEFAULT_CONFIG_PATH = '/app/config/gate.yaml';

const USAGE = `gate — homelab HTTP gateway

Usage:
  gate token create --subject <sub> --target <target> (--expires <duration> | --no-expiry)
                    [--issued-by <who>] [--note <text>] [--config <path>]
  gate token revoke --jti <jti> [--reason <text>] [--revoked-by <who>] [--config <path>]

token create options:
  --subject, -s    Subject the token is issued for (required)
  --target,  -t    Routing target embedded in the token (required)
  --expires, -e    Token lifetime, e.g. 15m, 1h, 24h
  --no-expiry      Issue a token without an "exp" claim
  --issued-by      Recorded in the token log (default: config, $GATE_ISSUED_BY, or user@host)
  --note           Optional note, recorded in the token log only

token revoke options:
  --jti            jti of the token to revoke (required; see the token log)
  --reason         Optional reason, recorded in the revocation list
  --revoked-by     Recorded in the revocation list (default: config, $GATE_ISSUED_BY, or user@host)

Common options:
  --config, -c     Config file path (default: $GATE_CONFIG or ${DEFAULT_CONFIG_PATH})
  --help, -h       Show this help

create prints the JWT to stdout; its metadata — never the token itself — is
appended to the append-only token log. revoke appends the jti to the revocation
list, after which Gate rejects that token even while its signature and exp are
still valid; the change takes effect without a restart.
`;

export async function run(argv: readonly string[]): Promise<number> {
  const [command, subcommand, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === 'token' && subcommand === 'create') {
    return tokenCreate(rest);
  }
  if (command === 'token' && subcommand === 'revoke') {
    return tokenRevoke(rest);
  }

  process.stderr.write(`error: unknown command "${[command, subcommand].filter(Boolean).join(' ')}"\n\n${USAGE}`);
  return 1;
}

async function tokenCreate(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        subject: { type: 'string', short: 's' },
        target: { type: 'string', short: 't' },
        expires: { type: 'string', short: 'e' },
        'no-expiry': { type: 'boolean' },
        'issued-by': { type: 'string' },
        note: { type: 'string' },
        config: { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    return fail((error as Error).message);
  }

  const values = parsed.values;

  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (values.subject === undefined || values.subject === '') {
    return fail('--subject is required');
  }
  if (values.target === undefined || values.target === '') {
    return fail('--target is required');
  }
  if (!TARGET_PATTERN.test(values.target)) {
    return fail(
      `--target "${values.target}" is not a valid identifier (a target is never a URL)`,
    );
  }

  const hasExpires = values.expires !== undefined;
  const hasNoExpiry = values['no-expiry'] === true;

  if (hasExpires && hasNoExpiry) {
    return fail('--expires and --no-expiry are mutually exclusive');
  }
  if (!hasExpires && !hasNoExpiry) {
    return fail('either --expires or --no-expiry is required');
  }

  let expiresInMs: number | undefined;
  if (hasExpires) {
    try {
      expiresInMs = parseDuration(values.expires as string);
    } catch (error) {
      if (error instanceof UnitParseError) return fail(error.message);
      throw error;
    }
    if (expiresInMs < 1000) {
      return fail('--expires must be at least 1s');
    }
  }

  // An explicit --config is used verbatim; otherwise follow the same fallback
  // the server uses when the mounted config directory is not writable.
  const configPath =
    values.config ?? resolveConfigPath(process.env['GATE_CONFIG'] ?? DEFAULT_CONFIG_PATH);

  let config;
  try {
    config = loadConfigFile(configPath, {
      checkKeyFiles: true,
      defaultIssuedBy: process.env['GATE_ISSUED_BY'],
    });
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }

  // Minting a token the verifier is configured to reject helps nobody, and the
  // failure would only show up as a 401 at request time.
  if (hasNoExpiry && config.jwt.requireExpiry) {
    return fail(
      'refusing to issue a token with no expiry: jwt.require_expiry is on, so Gate ' +
        'would reject it. Use --expires, or set jwt.require_expiry: false to allow ' +
        'tokens that never expire on their own (they can still be revoked by jti).',
    );
  }

  const target = values.target;
  if (!config.routes.some((route) => route.targetKey === target.toLowerCase())) {
    process.stderr.write(
      `warning: no route is configured for target "${target}"; ` +
        'requests using this token will be sent to the fallback service\n',
    );
  }

  let issued;
  try {
    const issuer = createTokenIssuer(config.jwt);
    issued = await issuer.issue({
      subject: values.subject,
      target,
      expiresInMs,
    });
  } catch (error) {
    if (error instanceof KeyLoadError) return fail(error.message);
    throw error;
  }

  // A blank --issued-by or GATE_ISSUED_BY counts as absent: the token log must
  // never record an empty issuer.
  const issuedBy =
    nonEmpty(values['issued-by']) ??
    config.tokenLog.defaultIssuedBy ??
    `${userInfo().username}@${hostname()}`;

  try {
    appendTokenLog(config.tokenLog.path, {
      jti: issued.jti,
      sub: issued.subject,
      target: issued.target,
      ...(issued.expiresAt === undefined ? {} : { exp: issued.expiresAt }),
      iat: issued.issuedAt,
      issued_by: issuedBy,
      ...(values.note === undefined ? {} : { note: values.note }),
    });
  } catch (error) {
    return fail(`token log write failed (${config.tokenLog.path}): ${(error as Error).message}`);
  }

  process.stderr.write(
    `issued jti=${issued.jti} sub=${issued.subject} target=${issued.target} ` +
      `exp=${issued.expiresAt === undefined ? 'never' : new Date(issued.expiresAt * 1000).toISOString()}\n`,
  );
  process.stdout.write(`${issued.token}\n`);
  return 0;
}

async function tokenRevoke(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        jti: { type: 'string' },
        reason: { type: 'string' },
        'revoked-by': { type: 'string' },
        config: { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    return fail((error as Error).message);
  }

  const values = parsed.values;

  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const jti = nonEmpty(values.jti);
  if (jti === undefined) {
    return fail('--jti is required');
  }

  const configPath =
    values.config ?? resolveConfigPath(process.env['GATE_CONFIG'] ?? DEFAULT_CONFIG_PATH);

  let config;
  try {
    // Revocation needs neither the private key nor a mint step, so the key
    // files are not required to be present just to revoke a token.
    config = loadConfigFile(configPath, {
      checkKeyFiles: false,
      defaultIssuedBy: process.env['GATE_ISSUED_BY'],
    });
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }

  // A jti that was never issued is almost always a typo. The token log is only
  // an audit trail, not the source of truth, so this is a warning, not an error
  // — and an unreadable or absent log means "unknown", never a false alarm.
  if (tokenLogHasJti(config.tokenLog.path, jti) === false) {
    process.stderr.write(
      `warning: no token with jti "${jti}" is recorded in the token log ` +
        `(${config.tokenLog.path}); revoking it anyway\n`,
    );
  }

  const revokedBy =
    nonEmpty(values['revoked-by']) ??
    config.tokenLog.defaultIssuedBy ??
    `${userInfo().username}@${hostname()}`;

  try {
    appendRevocation(config.revocation.path, {
      jti,
      revoked_at: Math.floor(Date.now() / 1000),
      revoked_by: revokedBy,
      ...(nonEmpty(values.reason) === undefined ? {} : { reason: values.reason }),
    });
  } catch (error) {
    return fail(
      `revocation list write failed (${config.revocation.path}): ${(error as Error).message}`,
    );
  }

  process.stderr.write(`revoked jti=${jti} by=${revokedBy}\n`);
  return 0;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await run(process.argv.slice(2));
}
