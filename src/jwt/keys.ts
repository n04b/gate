import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

export class KeyLoadError extends Error {}

export function loadPublicKey(path: string): KeyObject {
  return load(path, 'public');
}

export function loadPrivateKey(path: string): KeyObject {
  return load(path, 'private');
}

function load(path: string, kind: 'public' | 'private'): KeyObject {
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    throw new KeyLoadError(`cannot read ${kind} key ${path}: ${(error as Error).message}`);
  }

  try {
    return kind === 'public' ? createPublicKey(pem) : createPrivateKey(pem);
  } catch (error) {
    throw new KeyLoadError(`cannot parse ${kind} key ${path}: ${(error as Error).message}`);
  }
}
