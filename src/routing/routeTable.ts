import type { FallbackRoute, GateConfig, NormalRoute } from '../config/types.js';
import type { VerifiedToken } from '../jwt/verifier.js';

/**
 * Context handed to the route matcher.
 *
 * The MVP matches on `target` only, but the shape leaves room for the future
 * rule engine (method, path, headers, JWT claims — SPEC §62) without changing
 * call sites.
 */
export interface MatchContext {
  readonly target: string;
  readonly method: string;
  readonly path: string;
  readonly token: VerifiedToken | undefined;
}

export interface RouteTable {
  /** Returns the matching normal route, or `undefined` when there is none. */
  match(context: MatchContext): NormalRoute | undefined;
  /** The fallback route, or `undefined` when none is configured. */
  readonly fallback: FallbackRoute | undefined;
}

export function createRouteTable(config: GateConfig): RouteTable {
  const byTarget = new Map<string, NormalRoute>();
  for (const route of config.routes) {
    byTarget.set(route.targetKey, route);
  }

  return {
    match(context: MatchContext): NormalRoute | undefined {
      // Target comparison is case-insensitive (SPEC §16).
      return byTarget.get(context.target.toLowerCase());
    },
    fallback: config.fallback,
  };
}
