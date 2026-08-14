import { Transform, type Readable } from 'node:stream';

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds the configured limit of ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Wraps a request body stream and fails it as soon as more than `limit` bytes
 * have been seen (SPEC §42). Nothing is buffered — bytes flow straight through.
 */
export function limitBodyStream(source: Readable, limit: number): Readable {
  let seen = 0;

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        callback(new BodyTooLargeError(limit));
        return;
      }
      callback(null, chunk);
    },
  });

  source.on('error', (error) => limiter.destroy(error));
  source.pipe(limiter);

  return limiter;
}

/** `true` when `Content-Length` alone already exceeds the limit. */
export function declaredLengthExceeds(
  contentLength: string | string[] | undefined,
  limit: number,
): boolean {
  const raw = Array.isArray(contentLength) ? contentLength[0] : contentLength;
  if (raw === undefined) return false;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > limit;
}
