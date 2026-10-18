import type { ReportModel } from './reportModel.js'
import { z } from 'zod'
import type { LoanCoreAnalysis } from './loanCoreAnalysis.js'
import type { CaseContinuation } from '../caseEvidence/caseContinuation.js'

/** User-layer projection only: completeness is never inferred from a law number. */
export const legalBasisItemSchema = z.strictObject({
  authorityId: z.string().min(1),
  lawName: z.string().min(1), articleNumber: z.string().min(1), articleText: z.string(),
  sourceName: z.string().min(1), sourceUrl: z.string().url(),
  verificationStatus: z.enum(['VERIFIED', 'INCOMPLETE_TEXT', 'UNVERIFIED']),
  verificationExplanation: z.string().min(1),
  verificationDetails: z.strictObject({ sourceStatus: z.enum(['VERIFIED', 'PARTIALLY_VERIFIED', 'FAILED', 'VERIFICATION_FAILED']),
    articleCompleteness: z.enum(['COMPLETE', 'NOT_STORED']), ruleTextStatus: z.literal('VERIFIED'),
    legalStatus: z.enum(['UNKNOWN', 'EFFECTIVE', 'REPEALED', 'NOT_YET_EFFECTIVE']), versionStatus: z.enum(['VERIFIED', 'UNKNOWN']) }),
  versionIdentifier: z.string(), verifiedAt: z.string().datetime(),
  relatedQuestionIds: z.array(z.string()), relatedRuleIds: z.array(z.string()),
  relatedApplicationIds: z.array(z.string()), relatedFactIds: z.array(z.string()), relatedEvidenceIds: z.array(z.string()),
  relatedFacts: z.array(z.string()), relatedEvidence: z.array(z.string()),
  relevanceExplanation: z.string().min(1), evidenceExplanation: z.string().min(1),
  sourceTrace: z.array(z.strictObject({ candidateSourceId: z.string(), verificationId: z.string(),
    retrievalId: z.string(), sourceContentHash: z.string(), ruleEvidenceId: z.string() })),
}).refine(item => item.verificationStatus === 'VERIFIED' ? item.articleText.trim().length > 0 : item.articleText === '',
  'Only complete verified originals may be displayed as articleText')
  .refine(item => item.verificationStatus !== 'VERIFIED' || item.verificationDetails.sourceStatus === 'VERIFIED'
    && item.verificationDetails.articleCompleteness === 'COMPLETE' && item.verificationDetails.legalStatus === 'EFFECTIVE'
    && item.verificationDetails.versionStatus === 'VERIFIED', 'Verified display contradicts original verification scopes')
export type LegalBasisItem = z.infer<typeof legalBasisItemSchema>

/** Private trace data is never rendered as user text. Original IDs and statuses stay intact. */
export interface ActionTrace {
  factIds: string[]
  evidenceIds: string[]
  questionIds: string[]
  ruleIds: string[]
  applicationIds: string[]
  gapIds: string[]
}

export type AnalysisPremise = 'USER_ASSERTED' | 'PARTIAL_EVIDENCE' | 'NO_AUTHORITY' | 'CONFLICTING_EVIDENCE'
export type EvidenceFamily = 'payment' | 'chat' | 'identity' | 'timeline' | 'repayment' | 'other'

export interface ActionLegalBasis {
  name: string
  simpleExplanation: string
  caseRelevance: string
  officialSource: string
  originalText: string
  caveat: string
  trace: ActionTrace
}

export interface ActionQuestion {
  userFacingQuestion: string
  shortAnswer: string
  explanation: string
  legalBasis: ActionLegalBasis[]
  relatedEvidence: string[]
  premise: AnalysisPremise
  trace: ActionTrace
  legalBasisIds?: string[]
}

export interface EvidencePriority {
  family: EvidenceFamily
  title: string
  proofGoal: string
  alreadyHave: string[]
  recommendedEvidence: string[]
  importance: string
  trace: ActionTrace
  status?: 'MISSING' | 'PARTIAL' | 'SATISFIED'
  evidenceIds?: string[]
  missingFields?: string[]
}

/** A decision model, not the section/block structure of either existing report. */
export interface UserActionReportModel {
  continuation?: CaseContinuation
  loanCoreAnalysis?: LoanCoreAnalysis
  version: '2' | '2.1'
  caseTitle: string
  generatedAt: string
  currentAssessment: { text: string; premise: string; trace: ActionTrace }
  favorablePoints: Array<{ title: string; explanation: string; relatedFacts: string[];
    relatedEvidence: string[]; verificationCaveat: string; trace: ActionTrace }>
  attentionPoints: Array<{ title: string; explanation: string; trace: ActionTrace }>
  evidencePriorities: EvidencePriority[]
  caseMaterials?: Array<{ evidenceId: string; title: string; stage: string; relatedFactIds: string[]; relatedFacts: string[] }>
  userQuestions: ActionQuestion[]
  nextActions: Array<{ title: string; instruction: string; trace: ActionTrace }>
  legalBasis: ActionLegalBasis[]
  legalBasisItems?: LegalBasisItem[]
  researchLimitations: string[]
  appendixRef: { label: string }
  appendix: {
    allQuestions: ActionQuestion[]
    evidenceGaps: Array<{ description: string; purpose: string; suggestions: string[]; priority: 'HIGH' | 'MEDIUM' | 'LOW'; trace: ActionTrace }>
    facts: ReportModel['facts']
    factSupports: ReportModel['caseEvidenceAssessment']['factSupports']
    legalSources: ReportModel['ruleEvidence']
  }
}
