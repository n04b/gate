import type { IncomingHttpHeaders } from 'node:http';

/**
 * Returns the last value of a possibly repeated header.
 *
 * Node joins repeated headers with `, `, so both forms are handled: repeated
 * headers and a single comma-separated value (SPEC §17).
 */
export function lastHeaderValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined) return undefined;

  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');

  return values.length === 0 ? undefined : values[values.length - 1];
}

/** Returns a single header value without comma-splitting (e.g. `Authorization`). */
export function singleHeaderValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
