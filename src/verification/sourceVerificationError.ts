import type { VerificationEvidence } from './sourceVerificationSchema.js'

export type SourceVerificationErrorCode =
  | 'INTERNAL_ERROR'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_PROVIDER'
  | 'NETWORK_ERROR'
  | 'ACCESS_RESTRICTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'

/** Execution failures. An observed missing page or identity conflict belongs in
 * SourceVerificationResult instead; unavailable information remains UNKNOWN.
 */
export class SourceVerificationError extends Error {
  public evidence?: VerificationEvidence
  constructor(
    public readonly code: SourceVerificationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SourceVerificationError'
  }
}

export function isSourceExecutionFailure(error: unknown): error is SourceVerificationError {
  return error instanceof SourceVerificationError && ['NETWORK_ERROR', 'ACCESS_RESTRICTED', 'TIMEOUT', 'INVALID_RESPONSE'].includes(error.code)
}

