import type { Route } from '../config/types.js';

/**
 * Applies path mapping for the selected route (SPEC §45–§49).
 *
 * Mapping never applies to the fallback route, and never applies when it is
 * globally disabled.
 */
export function applyPathMapping(
  path: string,
  route: Route,
  mappingEnabled: boolean,
): string {
  if (route.kind === 'fallback') return path;
  if (!mappingEnabled) return path;

  const stripPrefix = route.mapping?.path?.stripPrefix;
  if (stripPrefix === undefined) return path;

  return stripPathPrefix(path, stripPrefix);
}

/**
 * `/n8n/` strips as:
 *   /n8n                → /
 *   /n8n/               → /
 *   /n8n/test           → /test
 *   /n8n/webhook/github → /webhook/github
 * A path that does not start with the prefix is passed through unchanged.
 */
export function stripPathPrefix(path: string, prefix: string): string {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (base === '') return path;

  if (path === base) return '/';
  if (path.startsWith(`${base}/`)) {
    const rest = path.slice(base.length);
    return rest === '' ? '/' : rest;
  }
  return path;
}
