import { z } from 'zod';

/**
 * Raw (YAML-shaped) configuration schema.
 *
 * Every object is `strict()` so unknown fields — including unknown route
 * fields — fail validation instead of being silently ignored.
 */

/**
 * Cloudflare Access service token for an external origin.
 *
 * `client_secret` is intentionally absent: the secret must be named by file or
 * environment variable, never written into the config file. An inline
 * `client_secret` therefore fails `strict()` — `buildAccessCredentials` turns
 * that into a directed error rather than a bare "unrecognized key".
 */
export const rawAccessSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret_file: z.string().min(1).optional(),
    client_secret_env: z.string().min(1).optional(),
    // Declared only so that inlining a secret gets a directed error instead of
    // a bare "unrecognized key". Any value other than absent is rejected.
    client_secret: z
      .undefined({
        invalid_type_error:
          'client_secret must not be written into the config file; ' +
          'use client_secret_file or client_secret_env',
      })
      .optional(),
  })
  .strict();

export const rawServiceSchema = z
  .object({
    url: z.string().min(1),
    access: rawAccessSchema.optional(),
    timeout: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

export const rawPathMappingSchema = z
  .object({
    strip_prefix: z.string().min(1),
  })
  .strict();

export const rawRouteMappingSchema = z
  .object({
    path: rawPathMappingSchema.optional(),
  })
  .strict();

export const rawNormalRouteSchema = z
  .object({
    target: z.string().min(1),
    service: z.string().min(1).optional(),
    auth: z.boolean().optional(),
    mapping: rawRouteMappingSchema.optional(),
  })
  .strict();

export const rawFallbackRouteSchema = z
  .object({
    fallback: z
      .object({
        service: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const rawServerSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    max_body_size: z.union([z.string(), z.number()]).optional(),
    upstream_timeout: z.union([z.string(), z.number()]).optional(),
    // Fastify accepts a boolean, an IP/CIDR (or comma-separated list), or a
    // hop count. Anything but a boolean lets an operator pin trust to the
    // proxy actually in front of Gate instead of trusting every peer.
    trust_proxy: z
      .union([z.boolean(), z.string().min(1), z.number().int().min(0)])
      .optional(),
  })
  .strict();

export const rawJwtSchema = z
  .object({
    algorithm: z.string().optional(),
    public_key: z.string().min(1),
    private_key: z.string().min(1),
    issuer: z.string().min(1).optional(),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    clock_tolerance: z.union([z.string(), z.number()]).optional(),
    require_expiry: z.boolean().optional(),
  })
  .strict();

export const rawMappingSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const rawLoggingSchema = z
  .object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  })
  .strict();

export const rawTokenLogSchema = z
  .object({
    path: z.string().min(1).optional(),
    issued_by: z.string().min(1).optional(),
  })
  .strict();

export const rawConfigSchema = z
  .object({
    server: rawServerSchema.optional(),
    jwt: rawJwtSchema,
    mapping: rawMappingSchema.optional(),
    logging: rawLoggingSchema.optional(),
    token_log: rawTokenLogSchema.optional(),
    services: z.record(z.string().min(1), rawServiceSchema),
    routes: z.array(z.unknown()),
  })
  .strict();

export type RawConfig = z.infer<typeof rawConfigSchema>;
