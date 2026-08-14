/**
 * Human friendly duration / byte-size parsing used by the YAML configuration
 * and the CLI (`--expires 1h`).
 */

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

export class UnitParseError extends Error {}

/** Parses `30s`, `15m`, `1h`, `7d`, `500ms` or a plain number of milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new UnitParseError(`invalid duration: ${value}`);
    }
    return Math.floor(value);
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(value);
  if (!match) {
    throw new UnitParseError(
      `invalid duration: "${value}" (expected e.g. 500ms, 30s, 15m, 1h, 7d)`,
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const factor = DURATION_UNITS[unit];
  if (factor === undefined) {
    throw new UnitParseError(`invalid duration unit: "${match[2]}"`);
  }
  return Math.floor(amount * factor);
}

/** Parses `1MB`, `512kb`, `1048576` into bytes. */
export function parseSize(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new UnitParseError(`invalid size: ${value}`);
    }
    return Math.floor(value);
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
  if (!match) {
    throw new UnitParseError(
      `invalid size: "${value}" (expected e.g. 1MB, 512KB, 1048576)`,
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor = SIZE_UNITS[unit];
  if (factor === undefined) {
    throw new UnitParseError(`invalid size unit: "${match[2]}"`);
  }
  const bytes = Math.floor(amount * factor);
  if (bytes <= 0) {
    throw new UnitParseError(`invalid size: "${value}"`);
  }
  return bytes;
}
