/** Error codes returned to clients. The body is always `{"error": "<code>"}`. */
export type GateErrorCode =
  | 'jwt_invalid'
  | 'jwt_target_missing'
  | 'unauthorized'
  | 'no_target'
  | 'no_route'
  | 'payload_too_large'
  | 'bad_gateway'
  | 'gateway_timeout'
  | 'internal_error';

export class GateError extends Error {
  readonly code: GateErrorCode;
  readonly statusCode: number;
  /** Never sent to the client; logged only. */
  readonly detail: string | undefined;

  constructor(code: GateErrorCode, statusCode: number, detail?: string) {
    super(code);
    this.name = 'GateError';
    this.code = code;
    this.statusCode = statusCode;
    this.detail = detail;
  }

  static jwtInvalid(detail?: string): GateError {
    return new GateError('jwt_invalid', 401, detail);
  }

  static jwtTargetMissing(): GateError {
    return new GateError('jwt_target_missing', 400);
  }

  static unauthorized(detail?: string): GateError {
    return new GateError('unauthorized', 401, detail);
  }

  /** No target could be resolved and no fallback is configured (SPEC §14). */
  static noTarget(detail?: string): GateError {
    return new GateError('no_target', 400, detail);
  }

  /** A target resolved but no route matched it and no fallback is configured. */
  static noRoute(detail?: string): GateError {
    return new GateError('no_route', 404, detail);
  }

  static payloadTooLarge(): GateError {
    return new GateError('payload_too_large', 413);
  }

  static badGateway(detail?: string): GateError {
    return new GateError('bad_gateway', 502, detail);
  }

  static gatewayTimeout(detail?: string): GateError {
    return new GateError('gateway_timeout', 504, detail);
  }
}
