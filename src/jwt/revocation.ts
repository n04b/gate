import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RevocationChecker } from './verifier.js';

/**
 * One revoked-token record in the revocation list. Only `jti` matters for the
 * check; the rest is audit metadata, mirroring the token log (SPEC §60).
 */
export interface RevocationRecord {
  readonly jti: string;
  readonly revoked_at: number;
  readonly revoked_by: string;
  readonly reason?: string;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Appends one JSON Lines record to the revocation list. Like the token log the
 * file is append-only — existing records are never read, rewritten or
 * truncated — and a repeated `jti` is harmless: the reader de-duplicates.
 */
export function appendRevocation(path: string, record: RevocationRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const ordered: Record<string, unknown> = {
    jti: record.jti,
    revoked_at: record.revoked_at,
    revoked_by: record.revoked_by,
  };
  if (record.reason !== undefined && record.reason !== '') ordered['reason'] = record.reason;

  appendFileSync(path, `${JSON.stringify(ordered)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Reads the set of revoked `jti`s. A missing file is an empty list, not an
 * error — nothing has been revoked yet. A malformed line (a hand edit, say) is
 * skipped rather than allowed to crash the gateway; the file is otherwise only
 * ever appended to by `gate token revoke`.
 */
export function readRevokedJtis(path: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }

  const jtis = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as { jti?: unknown };
      if (typeof parsed.jti === 'string' && parsed.jti !== '') jtis.add(parsed.jti);
    } catch {
      // Skip an unparsable line; a single bad entry must not disable the whole
      // list (and thereby honour tokens the operator meant to revoke).
    }
  }
  return jtis;
}

/**
 * A {@link RevocationChecker} backed by the revocation list file, wired into
 * the verifier in production. It picks up new revocations without a restart:
 * every check stats the file (cheap) and re-reads it only when its
 * size/mtime changes, so a busy gateway pays a stat, not a parse, per request.
 *
 * A stat error other than "file absent" keeps the last known set rather than
 * failing open — a transient read problem must not resurrect a revoked token.
 */
export function createFileRevocationChecker(path: string): RevocationChecker {
  let cache: { key: string; jtis: Set<string> } | undefined;

  function current(): ReadonlySet<string> {
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = undefined;
        return EMPTY;
      }
      return cache?.jtis ?? EMPTY;
    }

    const key = `${stat.mtimeMs}:${stat.size}`;
    if (cache?.key !== key) {
      cache = { key, jtis: readRevokedJtis(path) };
    }
    return cache.jtis;
  }

  return {
    isRevoked(jti) {
      // A token with no `jti` cannot be on the list; it is simply not revoked.
      if (jti === undefined) return false;
      return current().has(jti);
    },
  };
}
