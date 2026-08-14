import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { BodyTooLargeError, declaredLengthExceeds, limitBodyStream } from '../src/proxy/bodyLimit.js';

describe('limitBodyStream', () => {
  it('passes a body within the limit through unchanged', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const limited = limitBodyStream(source, 1024);
    expect((await buffer(limited)).toString()).toBe('hello world');
  });

  it('fails the stream as soon as the limit is exceeded', async () => {
    const source = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
    const limited = limitBodyStream(source, 1000);
    await expect(buffer(limited)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('propagates source errors', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('boom'));
      },
    });
    await expect(buffer(limitBodyStream(source, 1024))).rejects.toThrow('boom');
  });
});

describe('declaredLengthExceeds', () => {
  it('checks the Content-Length header', () => {
    expect(declaredLengthExceeds('2048', 1024)).toBe(true);
    expect(declaredLengthExceeds('1024', 1024)).toBe(false);
    expect(declaredLengthExceeds(undefined, 1024)).toBe(false);
    expect(declaredLengthExceeds('not-a-number', 1024)).toBe(false);
  });
});
