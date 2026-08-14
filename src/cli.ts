#!/usr/bin/env node
import { hostname, userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfigFile } from './config/load.js';
import { parseDuration, UnitParseError } from './config/units.js';
import { createTokenIssuer } from './jwt/issuer.js';
import { KeyLoadError } from './jwt/keys.js';
import { appendTokenLog } from './tokenlog/log.js';

const DEFAULT_CONFIG_PATH = '/app/config/gate.yaml';

const USAGE = `gate — homelab HTTP gateway

Usage:
  gate token create --subject <sub> --target <target> (--expires <duration> | --no-expiry)
                    [--issued-by <who>] [--note <text>] [--config <path>]

Options:
  --subject, -s    Subject the token is issued for (required)
  --target,  -t    Routing target embedded in the token (required)
  --expires, -e    Token lifetime, e.g. 15m, 1h, 24h
  --no-expiry      Issue a token without an "exp" claim
  --issued-by      Recorded in the token log (default: config, $GATE_ISSUED_BY, or user@host)
  --note           Optional note, recorded in the token log only
  --config, -c     Config file path (default: $GATE_CONFIG or ${DEFAULT_CONFIG_PATH})
  --help, -h       Show this help

The JWT is printed to stdout. Token metadata — never the token itself — is
appended to the append-only token log.
`;

export async function run(argv: readonly string[]): Promise<number> {
  const [command, subcommand, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command !== 'token' || subcommand !== 'create') {
    process.stderr.write(`error: unknown command "${[command, subcommand].filter(Boolean).join(' ')}"\n\n${USAGE}`);
    return 1;
  }

  return tokenCreate(rest);
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

  const configPath = values.config ?? process.env['GATE_CONFIG'] ?? DEFAULT_CONFIG_PATH;

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

  const issuedBy =
    values['issued-by'] ?? config.tokenLog.defaultIssuedBy ?? `${userInfo().username}@${hostname()}`;

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

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await run(process.argv.slice(2));
}
