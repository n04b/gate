import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Metadata of an issued token. The token itself is deliberately absent from
 * this type so it can never reach the log (SPEC §37).
 */
export interface TokenLogRecord {
  readonly jti: string;
  readonly sub: string;
  readonly target: string;
  readonly iat: number;
  readonly exp?: number;
  readonly issued_by: string;
  readonly note?: string;
}

/**
 * Appends one JSON Lines record. Existing records are never read, rewritten or
 * truncated — the file is opened in append mode only (SPEC §41).
 */
export function appendTokenLog(path: string, record: TokenLogRecord): void {
  // Matches the key directory in bootstrap.ts: the log names every issued jti.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const ordered: Record<string, unknown> = {
    jti: record.jti,
    sub: record.sub,
    target: record.target,
    iat: record.iat,
  };
  if (record.exp !== undefined) ordered['exp'] = record.exp;
  ordered['issued_by'] = record.issued_by;
  if (record.note !== undefined && record.note !== '') ordered['note'] = record.note;

  appendFileSync(path, `${JSON.stringify(ordered)}\n`, { encoding: 'utf8', mode: 0o600 });
}
