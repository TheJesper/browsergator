export type GatewayErrorCode =
  | 'TAB_NOT_FOUND'
  | 'TAB_PROTECTED'
  | 'LEASE_CONFLICT'
  | 'LEASE_EXPIRED'
  | 'BROWSER_DISCONNECTED'
  | 'NEEDS_HUMAN'
  | 'RESPONSE_BODY_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'INVALID_CONFIG'
  | 'INVALID_SELECTOR'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'WAIT_TIMEOUT'
  | 'DIALOG_NOT_OPEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EVALUATE_FAILED'
  | 'WRITE_CONFIRM_REQUIRED'
  | 'INTERNAL_ERROR';

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {})
    };
  }
}

export function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError(
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : 'Unexpected gateway error'
  );
}
