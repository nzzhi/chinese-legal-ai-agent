import type { ClaimSupport } from './reportModel.js'

/** Every condition is checked independently; UNKNOWN never authorizes a conclusion. */
export function canPublishLegalConclusion(support: ClaimSupport, context: {
  factIds: ReadonlySet<string>
  supportedFactIds?: ReadonlySet<string>
  legalQuestionIds: ReadonlySet<string>
  ruleEvidenceIds: ReadonlySet<string>
  topicMatches: boolean
}): boolean {
  return support.claimType === 'LEGAL_CONCLUSION'
    && support.supportStatus === 'SUPPORTED'
    && support.factIds.length > 0
    && support.factIds.every(id => context.factIds.has(id))
    && support.factIds.every(id => context.supportedFactIds?.has(id) === true)
    && context.legalQuestionIds.has(support.legalQuestionId)
    && support.ruleEvidenceIds.length > 0
    && support.ruleEvidenceIds.every(id => context.ruleEvidenceIds.has(id))
    && support.validityStatus === 'VERIFIED'
    && support.versionStatus === 'VERIFIED'
    && support.applicabilityStatus === 'HUMAN_REVIEWED'
    && context.topicMatches
}
