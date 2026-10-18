import type { SourceVerificationRequest, SourceVerificationResult } from './sourceVerificationSchema.js'

/** Each implementation declares provider support. No registry is needed for the
 * single current provider. The retrieval envelope preserves upstream membership.
 */
export interface LegalSourceVerifier {
  verify(request: SourceVerificationRequest, signal?: AbortSignal): Promise<SourceVerificationResult>
}

