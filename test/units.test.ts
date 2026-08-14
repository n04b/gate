import { describe, expect, it } from 'vitest';
import { parseDuration, parseSize, UnitParseError } from '../src/config/units.js';

describe('parseDuration', () => {
  it('parses supported units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('treats a bare number as milliseconds', () => {
    expect(parseDuration('250')).toBe(250);
    expect(parseDuration(250)).toBe(250);
  });

  it('rejects garbage', () => {
    expect(() => parseDuration('soon')).toThrow(UnitParseError);
    expect(() => parseDuration('1 week')).toThrow(UnitParseError);
    expect(() => parseDuration(-1)).toThrow(UnitParseError);
  });
});

describe('parseSize', () => {
  it('parses byte units case-insensitively', () => {
    expect(parseSize('1MB')).toBe(1_048_576);
    expect(parseSize('512kb')).toBe(524_288);
    expect(parseSize('1gb')).toBe(1_073_741_824);
    expect(parseSize('1048576')).toBe(1_048_576);
  });

  it('rejects garbage and non-positive sizes', () => {
    expect(() => parseSize('big')).toThrow(UnitParseError);
    expect(() => parseSize(0)).toThrow(UnitParseError);
  });
});
