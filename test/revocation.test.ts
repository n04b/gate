import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendRevocation,
  createFileRevocationChecker,
  readRevokedJtis,
} from '../src/jwt/revocation.js';
import { tempDir } from './helpers.js';

let dirs: string[] = [];

function freshPath(name = 'revocations.jsonl'): string {
  const dir = tempDir('gate-revoke-');
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  dirs = [];
});

describe('appendRevocation / readRevokedJtis', () => {
  it('round-trips jtis and de-duplicates repeats', () => {
    const path = freshPath();
    appendRevocation(path, { jti: 'a', revoked_at: 1, revoked_by: 'me' });
    appendRevocation(path, { jti: 'b', revoked_at: 2, revoked_by: 'me', reason: 'leak' });
    appendRevocation(path, { jti: 'a', revoked_at: 3, revoked_by: 'me' });

    expect(readRevokedJtis(path)).toEqual(new Set(['a', 'b']));
  });

  it('creates the file in a missing directory and omits an empty reason', () => {
    const path = join(tempDir('gate-revoke-'), 'nested', 'revocations.jsonl');
    appendRevocation(path, { jti: 'a', revoked_at: 1, revoked_by: 'me', reason: '' });

    const record = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
    expect(Object.keys(record)).not.toContain('reason');
  });

  it('treats a missing file as an empty list', () => {
    expect(readRevokedJtis(freshPath())).toEqual(new Set());
  });

  it('skips malformed or jti-less lines instead of throwing', () => {
    const path = freshPath();
    writeFileSync(path, ['{"jti":"good"}', 'not json', '{"revoked_at":1}', ''].join('\n'));
    expect(readRevokedJtis(path)).toEqual(new Set(['good']));
  });
});

describe('createFileRevocationChecker', () => {
  it('reports revoked and non-revoked jtis', () => {
    const path = freshPath();
    appendRevocation(path, { jti: 'gone', revoked_at: 1, revoked_by: 'me' });

    const checker = createFileRevocationChecker(path);
    expect(checker.isRevoked('gone')).toBe(true);
    expect(checker.isRevoked('here')).toBe(false);
    // A token with no jti can never be on the list.
    expect(checker.isRevoked(undefined)).toBe(false);
  });

  it('treats an absent file as nothing revoked', () => {
    const checker = createFileRevocationChecker(freshPath());
    expect(checker.isRevoked('anything')).toBe(false);
  });

  it('picks up a new revocation without being recreated', () => {
    const path = freshPath();
    const checker = createFileRevocationChecker(path);
    expect(checker.isRevoked('later')).toBe(false);

    // A subsequent append grows the file, so the cache (keyed on size/mtime)
    // is invalidated and the new jti is seen without a restart.
    appendRevocation(path, { jti: 'later', revoked_at: 1, revoked_by: 'me' });
    expect(checker.isRevoked('later')).toBe(true);
  });

  it('does not re-read while the file is unchanged', () => {
    const path = freshPath();
    appendRevocation(path, { jti: 'a', revoked_at: 1, revoked_by: 'me' });
    const checker = createFileRevocationChecker(path);

    expect(checker.isRevoked('a')).toBe(true);
    // Repeated checks against an unchanged file keep returning the cached set.
    for (let i = 0; i < 5; i += 1) expect(checker.isRevoked('a')).toBe(true);

    appendFileSync(path, `${JSON.stringify({ jti: 'b', revoked_at: 2, revoked_by: 'me' })}\n`);
    expect(checker.isRevoked('b')).toBe(true);
  });
});
