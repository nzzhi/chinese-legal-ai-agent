import type { Fact, FactCertainty } from '../case/caseSchema.js'
import type { CaseEvidenceAssessment } from '../caseEvidence/caseEvidence.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import type { EvidenceFragment } from '../evidence/evidenceFragmentSchema.js'
import type { LegalRuleEvidence } from '../legalRule/legalRuleSchema.js'
import type { ExecutionStatus, ResearchStatus, QuestionResearchStatus } from '../integration/researchProgress.js'
import type { ReferenceCaseStatus, RetrievalStatus } from '../retrieval/queryFallback.js'

export interface ClaimSupport {
  id: string
  legalQuestionId: string
  factIds: string[]
  ruleEvidenceIds: string[]
  claimType: 'RULE_DESCRIPTION' | 'FACT_RULE_MATCH' | 'LEGAL_CONCLUSION'
  supportStatus: 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'
  validityStatus: 'VERIFIED' | 'UNKNOWN' | 'FAILED'
  versionStatus: 'VERIFIED' | 'UNKNOWN' | 'FAILED'
  applicabilityStatus: 'HUMAN_REVIEWED' | 'UNKNOWN' | 'REJECTED'
  reasoning?: string
}

export interface RuleCitation {
  ruleEvidenceId: string
  verifiedSourceId: string
  candidateSourceId: string
  sourceUrl: string
  contentHash: string
  characterStart: number
  characterEnd: number
  exactQuote: string
}

export interface ReportClaim {
  claim: string
  support: ClaimSupport
  citations: RuleCitation[]
}

export type IssueAssessmentStatus = 'CLEAR_BASIS' | 'CONDITIONAL_BASIS' | 'INSUFFICIENT_BASIS'
  | 'NEEDS_FACTS' | 'INSUFFICIENT_AUTHORITY' | 'NOT_RESEARCHED'

export interface CaseOverview {
  userGoals: Array<{ id: string; description: string; relatedFactIds: string[]; legalQuestionIds: string[] }>
  keyFacts: Array<{ id: string; content: string; certainty: FactCertainty }>
  disputedFacts: Array<{ id: string; topic: string; userPosition?: string; opposingPosition?: string;
    relatedFactIds: string[] }>
  unconfirmedFacts: Array<{ id: string; content: string; certainty: FactCertainty }>
  coreIssues: Array<{ legalQuestionId: string; issueId: string; question: string }>
}

export interface IssueAssessment {
  legalQuestionId: string
  issueId: string
  question: string
  status: IssueAssessmentStatus
  statusText: string
  supportingFactIds: string[]
  ruleEvidenceIds: string[]
  applicationIds: string[]
  analysis: string[]
  uncertainty: string[]
}

export interface MaterialGap {
  id: string
  kind: 'UNKNOWN_FACT' | 'DISPUTED_FACT' | 'APPLICATION_EVIDENCE_GAP' | 'CASE_EVIDENCE_GAP'
  description: string
  importance: 'HIGH' | 'MEDIUM'
  whyItMatters: string
  suggestedEvidence: string[]
  legalQuestionIds: string[]
  relatedFactIds: string[]
}

export interface RecommendedAction {
  order: number
  action: string
  whyNow: string
  materials: string[]
  legalQuestionIds: string[]
}

export interface LegalAuthoritySummary {
  ruleId: string
  legalName: string
  article: string
  ruleText: string
  legalQuestionIds: string[]
  legalStatus: LegalRuleEvidence['legalStatus']
  versionStatus: LegalRuleEvidence['version']
  citation: RuleCitation
}

export interface ReferenceMaterialSummary {
  title: string
  url?: string
  verified: boolean
  notice: string
}

export interface InternalDiagnostics {
  retrievalStatus?: RetrievalStatus
  executionStatus: ExecutionStatus
  researchStatus: ResearchStatus
  questionCoverage: Array<{ legalQuestionId: string; status: 'PLANNED' | 'MISSING'; legalSearchQueryId?: string }>
  authorityCoverage: Array<{ legalQuestionId: string; status: QuestionResearchStatus }>
  referenceStatus?: ReferenceCaseStatus
  unexecutedQueries: Array<{ legalQuestionId: string; legalSearchQueryId: string; queryKind: 'PRIMARY' | 'FALLBACK';
    sourcePurpose?: 'AUTHORITY' | 'REFERENCE'; reason: 'QUERY_BUDGET_EXHAUSTED' | 'PRIMARY_NOT_EXECUTED' | 'REFERENCE_BUDGET_EXHAUSTED' }>
}

/** The structured report is the source of truth; exporters render its ordered sections. */
export interface ReportModel {
  title: string
  subtitle: string
  generatedAt: string
  executionStatus: ExecutionStatus
  researchStatus: ResearchStatus
  authorityCoverage: Array<{ legalQuestionId: string; status: QuestionResearchStatus }>
  facts: Fact[]
  caseEvidenceAssessment: CaseEvidenceAssessment
  legalQuestions: LegalQuestion[]
  ruleEvidence: Array<{ fragment: EvidenceFragment; rule: LegalRuleEvidence; citation: RuleCitation }>
  claimSupports: ClaimSupport[]
  supportedClaims: ReportClaim[]
  unresolvedIssues: Array<{ legalQuestionId: string; factIds: string[]; ruleEvidenceIds: string[]; reason: string }>
  caseOverview: CaseOverview
  issueAssessments: IssueAssessment[]
  materialGaps: MaterialGap[]
  recommendedActions: RecommendedAction[]
  legalAuthorities: LegalAuthoritySummary[]
  referenceMaterials: ReferenceMaterialSummary[]
  internalDiagnostics: InternalDiagnostics
  sections: { title: string; blocks: ReportBlock[] }[]
}

export interface ReportBlock {
  kind: 'heading' | 'paragraph' | 'quote'
  text: string
  /** A separate target prevents surrounding punctuation becoming part of the URL. */
  href?: string
}

export const disclaimer = '本报告由法律研究辅助系统根据用户提供的信息及检索到的公开法律资料生成，仅供法律研究和信息参考，不构成律师出具的正式法律意见或对案件结果的保证。'
