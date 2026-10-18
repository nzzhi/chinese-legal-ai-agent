import { caseSchema, type Case } from '../case/caseSchema.js'
import { caseSnapshotId, assertCaseSnapshot, bindGeneratedQuestions } from '../case/caseSnapshot.js'
import type { ConditionalAnalyzer, ConditionalAnalysisResult } from '../legalRule/conditionalAnalysis.js'
import { assessCaseEvidence, caseEvidenceInputSchema, type CaseEvidenceInput, type CaseEvidenceAssessment } from '../caseEvidence/caseEvidence.js'
import type { CaseClassifier } from '../classification/caseClassifier.js'
import type { ClassificationResult, DisputeAnalysisResult } from '../classification/classificationSchema.js'
import type { DisputeIdentifier } from '../classification/disputeIdentifier.js'
import type { FactExtractor } from '../extraction/factExtractor.js'
import type { LegalQueryBuilder } from '../legalQuery/legalQueryBuilder.js'
import type { LegalSearchQuery, PlannedLegalSearchQuery } from '../legalQuery/legalQuerySchema.js'
import type { LegalQuestionDecomposer } from '../legalQuestion/legalQuestionDecomposer.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import { assessReliefCoverage, type ReliefCoverage } from '../legalQuestion/reliefCoverage.js'
import { LegalQuestionError } from '../legalQuestion/legalQuestionError.js'
import type { LegalRetriever } from '../retrieval/legalRetriever.js'
import {
  retrieveWithFallback,
  type ProviderFailure,
  type RetrievalAttemptObservation,
  type RetrievalStatus,
  type ReferenceCaseStatus,
} from '../retrieval/queryFallback.js'
import type { CandidateLegalSource, LegalRetrievalResult } from '../retrieval/retrievalSchema.js'
import { isReferenceCase } from '../retrieval/sourceRole.js'
import type { LegalSourceVerifier } from '../verification/legalSourceVerifier.js'
import { randomUUID } from 'node:crypto'
import { isSourceExecutionFailure } from '../verification/sourceVerificationError.js'
import { sourceVerificationResultSchema, unobservedVerificationChecks } from '../verification/sourceVerificationSchema.js'
import type { SourceVerificationResult } from '../verification/sourceVerificationSchema.js'
import { extractLegalRuleEvidence } from '../legalRule/legalRuleExtractor.js'
import type { LegalRuleApplication, LegalRuleEvidence } from '../legalRule/legalRuleSchema.js'
import type { RulePromotionDiagnostic } from '../legalRule/authorityQuestionGate.js'
import { assessResearchProgress, type ExecutionStatus, type ResearchStatus, type QuestionResearchStatus } from './researchProgress.js'
import {
  ResearchInstrumentation,
  type ResearchMetrics,
  type ResearchStageName,
} from './researchInstrumentation.js'

export interface ResearchWorkflowDependencies {
  factExtractor: FactExtractor
  caseClassifier: CaseClassifier
  disputeIdentifier: DisputeIdentifier
  legalQuestionDecomposer: LegalQuestionDecomposer
  legalQueryBuilder: LegalQueryBuilder
  legalRetriever: LegalRetriever
  legalSourceVerifier: LegalSourceVerifier
  conditionalAnalyzer?: ConditionalAnalyzer
  canStartRetrievalProviderCall?: () => boolean
  canStartReferenceProviderCall?: () => boolean
  canStartReferenceVerification?: () => boolean
}

export interface WorkflowStageEvent {
  stage: ResearchStageName
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'DEGRADED'
  durationMs?: number
  error?: Error
}

export interface RetrievedQuery {
  query: LegalSearchQuery
  retrieval: LegalRetrievalResult
}

export interface CandidateVerification {
  caseSnapshotId?: string
  query: LegalSearchQuery
  retrieval: LegalRetrievalResult
  candidate: CandidateLegalSource
  result: SourceVerificationResult
}

/** A composition of the existing Step 1–9 interfaces. It owns no legal logic. */
export interface ResearchWorkflowResult {
  caseSnapshotId?: string
  conditionalAnalysis?: ConditionalAnalysisResult
  retrievalStatus: RetrievalStatus
  executionStatus: ExecutionStatus
  researchStatus: ResearchStatus
  providerFailures: ProviderFailure[]
  rawCase: string
  case: Case
  caseEvidence?: CaseEvidenceInput
  caseEvidenceAssessment?: CaseEvidenceAssessment
  classification: ClassificationResult
  disputeAnalysis: DisputeAnalysisResult
  legalQuestions: LegalQuestion[]
  reliefCoverage?: ReliefCoverage[]
  legalSearchQueries: PlannedLegalSearchQuery[]
  retrievedQueries: RetrievedQuery[]
  candidateVerifications: CandidateVerification[]
  legalRules: LegalRuleEvidence[]
  ruleApplications: LegalRuleApplication[]
  rulePromotionDiagnostics?: RulePromotionDiagnostic[]
  authorityCoverage: Array<{ legalQuestionId: string; status: QuestionResearchStatus }>
  referenceCaseStatus: ReferenceCaseStatus
  verificationStatistics: { verified: number; rejected: number; failed: number; partiallyVerified: number; total: number }
  verificationWarnings: Array<{ sourceId: string; status: SourceVerificationResult['status']; message: string }>
  metrics: ResearchMetrics
  queryExecutions: Awaited<ReturnType<typeof retrieveWithFallback>>['queryExecutions']
  mergedSources: Awaited<ReturnType<typeof retrieveWithFallback>>['mergedSources']
  retrievalStatistics: Awaited<ReturnType<typeof retrieveWithFallback>>['statistics']
  unexecutedQueries: Awaited<ReturnType<typeof retrieveWithFallback>>['unexecutedQueries']
  questionCoverage: Awaited<ReturnType<typeof retrieveWithFallback>>['questionCoverage']
  caseReferencePolicy: {
    relevanceDimensions: readonly ['legal relationship similarity', 'dispute issue similarity', 'factual similarity']
    requireIdenticalFacts: false
    notice: string
  }
}

export class ResearchWorkflow {
  private readonly instrumentation: ResearchInstrumentation
  private readonly onStage?: (event: WorkflowStageEvent) => void

  constructor(
    private readonly dependencies: ResearchWorkflowDependencies,
    options: {
      instrumentation?: ResearchInstrumentation
      onProviderFailure?: (failure: ProviderFailure) => void
      onRetrievalAttempt?: (observation: RetrievalAttemptObservation) => void
      onVerification?: (result: SourceVerificationResult) => void
      onStage?: (event: WorkflowStageEvent) => void
      now?: () => number
    } = {},
  ) {
    this.instrumentation = options.instrumentation ?? new ResearchInstrumentation()
    this.onProviderFailure = options.onProviderFailure
    this.onRetrievalAttempt = options.onRetrievalAttempt
    this.onStage = options.onStage
    this.onVerification = options.onVerification
    this.now = options.now ?? (() => performance.now())
  }

  private readonly onVerification?: (result: SourceVerificationResult) => void
  private readonly onProviderFailure?: (failure: ProviderFailure) => void
  private readonly onRetrievalAttempt?: (observation: RetrievalAttemptObservation) => void
  private readonly now: () => number

  async run(rawCase: string, options: { caseEvidence?: unknown; initialCase?: unknown;
    prepareEvidence?: (caseData: Case) => Promise<unknown>;
    onDerivedStage?: (stage: 'Rule Extraction' | 'Conditional Analysis' | 'Research Progress', result?: unknown) => void } = {}): Promise<ResearchWorkflowResult> {
    const startedAt = this.now()
    if (options.caseEvidence !== undefined && options.prepareEvidence) throw new Error('Choose one evidence input path')
    const providedEvidence = caseEvidenceInputSchema.parse(options.caseEvidence ?? { items: [], links: [] })
    const caseData = options.initialCase === undefined
      ? await this.runStage('Fact Extraction', () => this.dependencies.factExtractor.extract(rawCase))
      : caseSchema.parse(options.initialCase)
    const snapshot = caseSnapshotId(caseData)
    // Workspace links target this extracted/persisted Case; resuming must not replace its Fact IDs.
    const caseEvidence = options.prepareEvidence
      ? caseEvidenceInputSchema.parse(await options.prepareEvidence(caseData)) : providedEvidence
    assessCaseEvidence({ case: caseData, legalQuestions: [], ruleApplications: [], evidence: caseEvidence })
    const classification = await this.runStage('Classification', () => this.dependencies.caseClassifier.classify(caseData))
    const disputeAnalysis = await this.runStage(
      'Dispute Identification',
      () => this.dependencies.disputeIdentifier.analyze(caseData),
    )
    assertCaseSnapshot(caseData, snapshot)
    let reliefCoverage: ReliefCoverage[] = []
    const legalQuestions = await this.runStage('Legal Questions', async () => {
      const generated = await this.dependencies.legalQuestionDecomposer.decompose({
        rawCase, case: caseData, classification, disputeAnalysis,
      })
      const questions = bindGeneratedQuestions(caseData, generated, snapshot)
      reliefCoverage = assessReliefCoverage(rawCase, caseData, questions)
      if (reliefCoverage.some(item => item.status === 'MISSING')) {
        throw new LegalQuestionError('INVALID_RESPONSE', 'MISSING_RELIEF_COVERAGE', { reliefCoverage })
      }
      return questions
    })
    assertCaseSnapshot(caseData, snapshot)
    const legalSearchQueries = await this.runStage(
      'Search Queries',
      () => this.dependencies.legalQueryBuilder.build(legalQuestions),
    )
    assertCaseSnapshot(caseData, snapshot)
    const { retrievedQueries, queryExecutions, mergedSources, providerFailures, unexecutedQueries, questionCoverage,
      retrievalStatus, referenceCaseStatus, statistics: retrievalStatistics } = await this.runStage('Retrieval', () =>
      retrieveWithFallback(legalSearchQueries, this.dependencies.legalRetriever,
        () => this.instrumentation.recordRetrievalOperation(), this.onProviderFailure,
        () => this.instrumentation.recordRetrievalReuse(), this.onRetrievalAttempt, {
          importanceByLegalQuestionId: new Map(legalQuestions.map(({ id, importance }) => [id, importance])),
          legalQuestions,
          requiredLegalQuestionIds: legalQuestions.map(({ id }) => id),
          canStartProviderRequest: this.dependencies.canStartRetrievalProviderCall,
          canStartReferenceProviderRequest: this.dependencies.canStartReferenceProviderCall,
        }),
      (result) => result.retrievalStatus === 'COMPLETE' ? 'SUCCEEDED' : result.retrievalStatus)
    const candidateVerifications = await this.runStage('Source Verification', async () => {
      const results: CandidateVerification[] = []
      const attempted = new Set<string>()
      for (const referencePass of [false, true]) {
        for (const { query, retrieval } of retrievedQueries) {
          for (const candidate of retrieval.sources) {
            const reference = query.sourcePurpose === 'REFERENCE' || isReferenceCase(candidate)
            // Source bytes may be shared, but verification also binds the question/query provenance.
            const verificationKey = JSON.stringify([query.legalQuestionId, candidate.sourceId])
            if (reference !== referencePass || attempted.has(verificationKey)) continue
            attempted.add(verificationKey)
            if (reference && this.dependencies.canStartReferenceVerification
              && !this.dependencies.canStartReferenceVerification()) continue
            this.instrumentation.recordVerificationOperation()
            let result: SourceVerificationResult
            try {
              result = await this.dependencies.legalSourceVerifier.verify({ retrieval, candidateSourceId: candidate.sourceId,
                query, legalQuestion: legalQuestions.find(question => question.id === query.legalQuestionId) })
            } catch (error) {
              if (!isSourceExecutionFailure(error)) throw error
              result = sourceVerificationResultSchema.parse({
                verificationId: `verification-${randomUUID()}`, candidateSourceId: candidate.sourceId,
                retrievalId: retrieval.retrievalId, legalQuestionId: retrieval.legalQuestionId,
                legalSearchQueryId: retrieval.legalSearchQueryId, providerId: retrieval.providerId,
                providerSourceId: candidate.record.providerSourceId, checkedAt: new Date().toISOString(),
                status: 'VERIFICATION_FAILED', failure: { code: error.code, message: error.message },
                checks: unobservedVerificationChecks(), evidence: { requestedUrl: candidate.record.sourceUrl, redirects: [], ...error.evidence },
              })
            }
            // Schema/programming failures are batch-level errors, never candidate failures.
            result = sourceVerificationResultSchema.parse(result)
            if (result.candidateSourceId !== candidate.sourceId || result.providerSourceId !== candidate.record.providerSourceId
              || result.retrievalId !== retrieval.retrievalId || result.providerId !== retrieval.providerId
              || result.legalQuestionId !== retrieval.legalQuestionId || result.legalSearchQueryId !== retrieval.legalSearchQueryId) {
              throw new Error('Verification result provenance contradicts candidate retrieval')
            }
            results.push({ caseSnapshotId: snapshot, query, retrieval, candidate, result })
            this.onVerification?.(result)
          }
        }
      }
      return results
    })
    assertCaseSnapshot(caseData, snapshot)
    const conditionalAnalysis = this.dependencies.conditionalAnalyzer
      ? await this.runStage('Conditional Analysis', () => this.dependencies.conditionalAnalyzer!.analyze({
        caseSnapshotId: snapshot, case: caseData, caseEvidence, legalQuestions, candidateVerifications,
      }), result => result.blocked?.length || result.questions.some(q => 'analysisStatus' in q && q.analysisStatus === 'NO_VERIFIED_AUTHORITY')
        ? 'DEGRADED' : 'SUCCEEDED') : undefined
    assertCaseSnapshot(caseData, snapshot)
    options.onDerivedStage?.('Rule Extraction')
    const { legalRules, ruleApplications, rulePromotionDiagnostics } = extractLegalRuleEvidence({
      case: caseData, legalQuestions, retrievedQueries,
      // Legacy legalRules remain exact quotation evidence for existing report formats.
      // New normative propositions live in conditionalAnalysis.rules, never in a quote field.
      candidateVerifications: conditionalAnalysis ? candidateVerifications.filter(v => conditionalAnalysis.questions
        .some(q => q.legalQuestionId === v.query.legalQuestionId && q.authoritySelections
          .some(a => a.authorityId === v.result.providerSourceId && a.selectedForRule))) : candidateVerifications,
    })
    options.onDerivedStage?.('Rule Extraction', { legalRules, ruleApplications, rulePromotionDiagnostics })
    options.onDerivedStage?.('Research Progress')
    const { executionStatus, researchStatus, authorityCoverage } = assessResearchProgress({
      legalQuestions, retrievalStatus, questionCoverage,
      retrievedQueries, providerFailures, unexecutedQueries, candidateVerifications,
      legalRules, ruleApplications, conditionalAnalysis,
    })
    options.onDerivedStage?.('Research Progress', { executionStatus, researchStatus, authorityCoverage })

    return {
      caseSnapshotId: snapshot,
      ...(conditionalAnalysis ? { conditionalAnalysis } : {}),
      retrievalStatus,
      executionStatus,
      researchStatus,
      referenceCaseStatus,
      providerFailures,
      rawCase,
      case: caseData,
      caseEvidence,
      caseEvidenceAssessment: assessCaseEvidence({ case: caseData, legalQuestions, ruleApplications, disputeAnalysis, evidence: caseEvidence }),
      classification,
      disputeAnalysis,
      legalQuestions,
      reliefCoverage,
      legalSearchQueries,
      retrievedQueries,
      candidateVerifications,
      legalRules,
      ruleApplications,
      authorityCoverage,
      rulePromotionDiagnostics,
      verificationStatistics: {
        total: candidateVerifications.length,
        verified: candidateVerifications.filter(({ result }) => result.status === 'VERIFIED').length,
        rejected: candidateVerifications.filter(({ result }) => result.status === 'FAILED').length,
        failed: candidateVerifications.filter(({ result }) => result.status === 'VERIFICATION_FAILED').length,
        partiallyVerified: candidateVerifications.filter(({ result }) => result.status === 'PARTIALLY_VERIFIED').length,
      },
      verificationWarnings: candidateVerifications.filter(({ result }) => result.status !== 'VERIFIED').map(({ result }) => ({
        sourceId: result.candidateSourceId, status: result.status,
        message: result.failure ? `${result.failure.code}: ${result.failure.message}` : Object.values(result.checks)
          .filter((check) => check.status === 'UNKNOWN' || check.status === 'MISMATCH').map((check) => check.reason).join('; '),
      })),
      queryExecutions,
      mergedSources,
      retrievalStatistics,
      unexecutedQueries,
      questionCoverage,
      caseReferencePolicy: {
        relevanceDimensions: ['legal relationship similarity', 'dispute issue similarity', 'factual similarity'],
        requireIdenticalFacts: false,
        notice: '案例仅作为类似裁判思路参考，具体结论仍取决于本案事实、证据及适用法律。',
      },
      metrics: this.instrumentation.snapshot(this.now() - startedAt),
    }
  }

  private async runStage<T>(stage: ResearchStageName, operation: () => Promise<T>,
    completionStatus: (result: T) => WorkflowStageEvent['status'] = () => 'SUCCEEDED',
  ): Promise<T> {
    const startedAt = this.now()
    this.onStage?.({ stage, status: 'STARTED' })
    try {
      const result = await operation()
      const durationMs = this.now() - startedAt
      this.instrumentation.recordStage(stage, durationMs)
      this.onStage?.({ stage, status: completionStatus(result), durationMs })
      return result
    } catch (error) {
      const durationMs = this.now() - startedAt
      this.instrumentation.recordStage(stage, durationMs)
      this.onStage?.({
        stage,
        status: 'FAILED',
        durationMs,
        error: error instanceof Error ? error : new Error(String(error)),
      })
      throw error
    }
  }
}
