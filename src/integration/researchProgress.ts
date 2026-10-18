import type { RetrievalStatus } from '../retrieval/queryFallback.js'
import type { SourcePurpose } from '../legalQuery/legalQuerySchema.js'
import type { SourceVerificationResult } from '../verification/sourceVerificationSchema.js'
import type { CandidateLegalSource } from '../retrieval/retrievalSchema.js'
import { isReferenceCase } from '../retrieval/sourceRole.js'

export type ExecutionStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED'
export type ResearchStatus = 'COMPLETE' | 'INSUFFICIENT_AUTHORITY' | 'INDETERMINATE' | 'NO_LEGAL_QUESTIONS'
export type QuestionResearchStatus = 'RULE_EVIDENCE_FOUND' | 'INSUFFICIENT_AUTHORITY' | 'NOT_RESEARCHED'

type QueryLink = { legalQuestionId: string; sourcePurpose?: SourcePurpose }

export interface ResearchProgressInput {
  legalQuestions: readonly { id: string }[]
  conditionalAnalysis?: { blocked?: readonly { legalQuestionId: string }[] }
  retrievalStatus?: RetrievalStatus
  questionCoverage?: readonly { legalQuestionId: string; status: 'PLANNED' | 'MISSING' }[]
  retrievedQueries: readonly { query: QueryLink; retrieval: { complete: boolean } }[]
  providerFailures?: readonly { query: QueryLink }[]
  unexecutedQueries?: readonly (QueryLink & { reason?: string })[]
  candidateVerifications: readonly { query: QueryLink; candidate?: CandidateLegalSource; result: Pick<SourceVerificationResult,
    'status' | 'verificationId' | 'verifiedSource'> }[]
  legalRules: readonly { ruleId: string; source: { verificationId: string } }[]
  ruleApplications: readonly { legalQuestionId: string; legalRuleId: string }[]
}

/** A located Rule linked through an Application is research material, not a legal conclusion. */
export function assessResearchProgress(input: ResearchProgressInput): {
  executionStatus: ExecutionStatus
  researchStatus: ResearchStatus
  authorityCoverage: Array<{ legalQuestionId: string; status: QuestionResearchStatus }>
} {
  if (input.legalQuestions.length === 0) {
    return { executionStatus: 'COMPLETE', researchStatus: 'NO_LEGAL_QUESTIONS', authorityCoverage: [] }
  }
  const authority = (query: QueryLink) => query.sourcePurpose !== 'REFERENCE'
  const incompleteQuestion = (id: string) =>
    input.conditionalAnalysis?.blocked?.some(q => q.legalQuestionId === id)
    || input.retrievalStatus === undefined || input.providerFailures === undefined
    || input.unexecutedQueries === undefined
    || input.questionCoverage?.find(item => item.legalQuestionId === id)?.status !== 'PLANNED'
    || !input.retrievedQueries.some(item => authority(item.query) && item.query.legalQuestionId === id)
    || input.retrievedQueries.some(item => authority(item.query) && item.query.legalQuestionId === id && !item.retrieval.complete)
    || (input.providerFailures ?? []).some(item => authority(item.query) && item.query.legalQuestionId === id)
    || (input.unexecutedQueries ?? []).some(item => authority(item) && item.legalQuestionId === id)
    || input.candidateVerifications.some(item => authority(item.query)
      && (!item.candidate || !isReferenceCase(item.candidate, item.result.verifiedSource?.title))
      && item.query.legalQuestionId === id && item.result.status === 'VERIFICATION_FAILED')
  const ruleIds = new Set(input.legalRules.filter(rule => input.candidateVerifications.some(item =>
    authority(item.query) && (!item.candidate || !isReferenceCase(item.candidate, item.result.verifiedSource?.title))
    && item.result.status === 'VERIFIED' && item.result.verifiedSource
    && item.result.verificationId === rule.source.verificationId)).map(rule => rule.ruleId))
  const authorityCoverage = input.legalQuestions.map(question => ({
    legalQuestionId: question.id,
    status: (incompleteQuestion(question.id) ? 'NOT_RESEARCHED'
      : input.ruleApplications.some(item => item.legalQuestionId === question.id && ruleIds.has(item.legalRuleId))
        ? 'RULE_EVIDENCE_FOUND' : 'INSUFFICIENT_AUTHORITY') as QuestionResearchStatus,
  }))
  const executionStatus: ExecutionStatus = input.retrievalStatus === 'COMPLETE'
    && !(input.conditionalAnalysis?.blocked?.length)
    && (input.providerFailures ?? []).length === 0
    && (input.unexecutedQueries ?? []).length === 0
    && input.retrievedQueries.every(item => item.retrieval.complete)
    && input.candidateVerifications.every(item => item.result.status !== 'VERIFICATION_FAILED')
    ? 'COMPLETE' : 'PARTIAL'
  const researchStatus: ResearchStatus = authorityCoverage.some(item => item.status === 'NOT_RESEARCHED')
    ? 'INDETERMINATE'
    : authorityCoverage.some(item => item.status === 'INSUFFICIENT_AUTHORITY')
      ? 'INSUFFICIENT_AUTHORITY' : 'COMPLETE'
  return { executionStatus, researchStatus, authorityCoverage }
}
