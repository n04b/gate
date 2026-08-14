import {
  bootstrap,
  bootstrapEnabled,
  BootstrapError,
  resolveConfigPath,
} from './bootstrap.js';
import { ConfigError, loadConfigFile } from './config/load.js';
import { buildServer } from './server.js';

const DEFAULT_CONFIG_PATH = '/app/config/gate.yaml';

async function main(): Promise<void> {
  const requestedConfigPath = process.env['GATE_CONFIG'] ?? DEFAULT_CONFIG_PATH;
  let configPath = resolveConfigPath(requestedConfigPath);

  if (bootstrapEnabled(process.env['GATE_BOOTSTRAP'])) {
    try {
      const result = bootstrap(requestedConfigPath);
      configPath = result.configPath;

      if (result.configCreated) {
        process.stderr.write(
          `gate: no config found, wrote a default one to ${result.configPath}\n`,
        );
      }
      if (result.configFallbackUsed) {
        const uid = process.getuid?.() ?? 'unknown';
        process.stderr.write(
          `gate: ${requestedConfigPath} is not writable by uid ${uid}, so ${result.configPath} ` +
            'is used instead. To keep the config on the host, make the mounted directory ' +
            `writable for uid ${uid} and copy the file there ` +
            `(docker cp gate:${result.configPath} ./config/gate.yaml).\n`,
        );
      }
      if (result.keysCreated) {
        process.stderr.write(`gate: generated a JWT key pair at ${result.privateKeyPath}\n`);
      }
    } catch (error) {
      if (error instanceof BootstrapError) {
        process.stderr.write(`gate: ${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
  }

  let config;
  try {
    config = loadConfigFile(configPath, {
      checkKeyFiles: true,
      defaultIssuedBy: process.env['GATE_ISSUED_BY'],
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      // Configuration is validated before startup; Gate refuses to start on
      // any validation failure (SPEC §58).
      process.stderr.write(`gate: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const app = await buildServer({ config });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ host: config.server.host, port: config.server.port });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }

  app.log.info(
    {
      routes: config.routes.map((route) => ({
        target: route.target,
        service: route.service.name,
        auth: route.auth,
      })),
      fallback: config.fallback.service.name,
      mapping_enabled: config.mapping.enabled,
    },
    'gate started',
  );
}

await main();
