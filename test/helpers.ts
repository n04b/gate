import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

export interface TestKeys {
  readonly dir: string;
  readonly publicKeyPath: string;
  readonly privateKeyPath: string;
}

/** Writes a throwaway RS256 key pair into a temp directory. */
export function createTestKeys(): TestKeys {
  const dir = mkdtempSync(join(tmpdir(), 'gate-keys-'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const publicKeyPath = join(dir, 'jwt_public.pem');
  const privateKeyPath = join(dir, 'jwt_private.pem');

  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }) as string);
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);

  return { dir, publicKeyPath, privateKeyPath };
}

export function tempDir(prefix = 'gate-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface UpstreamServer {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** Replaces the default 200 handler. */
  respondWith(handler: (req: IncomingMessage, res: ServerResponse) => void): void;
  close(): Promise<void>;
}

/** Starts a real HTTP upstream so proxying is exercised end to end. */
export async function startUpstream(name = 'upstream'): Promise<UpstreamServer> {
  const requests: RecordedRequest[] = [];
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (handler !== undefined) {
        handler(req, res);
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': name });
      res.end(JSON.stringify({ upstream: name, path: req.url }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respondWith(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
