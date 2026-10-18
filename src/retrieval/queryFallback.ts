import { createHash, randomUUID } from 'node:crypto'
import type { PlannedLegalSearchQuery, LegalSearchQuery, SourcePurpose } from '../legalQuery/legalQuerySchema.js'
import type { LegalRetriever } from './legalRetriever.js'
import { isRecoverableRetrievalError, RetrievalError, type RetrievalErrorCode } from './retrievalError.js'
import type { CandidateLegalSource, LegalRetrievalResult } from './retrievalSchema.js'
import { isReferenceCase } from './sourceRole.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'

export interface ProviderFailure {
  providerId: string
  query: LegalSearchQuery
  errorCode: RetrievalErrorCode
  message: string
  fallbackAttempted: boolean
  retrievalDegraded: boolean
}

export type RetrievalStatus = 'COMPLETE' | 'DEGRADED' | 'FAILED'
export type ReferenceCaseStatus = 'FOUND' | 'NO_REFERENCE_CASE_FOUND' | 'NOT_SEARCHED' | 'BUDGET_EXHAUSTED' | 'SEARCH_FAILED'
export type RetrievalImportance = 'HIGH' | 'MEDIUM' | 'LOW'

export type QuestionQueryCoverage =
  | { legalQuestionId: string; status: 'PLANNED'; legalSearchQueryId: string }
  | { legalQuestionId: string; status: 'MISSING' }

export type RetrievalAttemptStopReason =
  | 'PRIMARY_RESULTS'
  | 'SOURCE_TARGET_REACHED'
  | 'QUERY_PLAN_EXHAUSTED'
  | 'PROVIDER_FAILURE'
  | 'BUDGET_EXCEEDED'
  | 'QUERY_BUDGET_EXHAUSTED'
  | 'REFERENCE_BUDGET_EXHAUSTED'
  | 'PRIMARY_NOT_EXECUTED'

export interface RetrievalAttemptObservation {
  sequence: number
  legalQuestionId: string
  legalSearchQueryId: string
  queryKind: 'PRIMARY' | 'FALLBACK'
  fallbackIndex?: number
  requestIdentityHash: string | null
  status: 'STARTED' | 'PROVIDER_COMPLETED' | 'REUSED' | 'PROVIDER_FAILURE' | 'BUDGET_BLOCKED' | 'NOT_EXECUTED'
  complete?: boolean
  resultCount?: number
  cacheStatus?: 'HIT' | 'MISS'
  reusedFromRetrievalId?: string
  errorCode?: RetrievalErrorCode | 'BUDGET_EXCEEDED'
  stopReason?: RetrievalAttemptStopReason
}

export interface UnexecutedQuery {
  legalQuestionId: string
  legalSearchQueryId: string
  queryKind: 'PRIMARY' | 'FALLBACK'
  fallbackIndex?: number
  sourcePurpose?: SourcePurpose
  reason: 'QUERY_BUDGET_EXHAUSTED' | 'PRIMARY_NOT_EXECUTED' | 'REFERENCE_BUDGET_EXHAUSTED'
}

export interface RetrievalDispatchOptions {
  legalQuestions?: readonly LegalQuestion[]
  importanceByLegalQuestionId?: ReadonlyMap<string, RetrievalImportance>
  canStartProviderRequest?: () => boolean
  canStartReferenceProviderRequest?: () => boolean
  requiredLegalQuestionIds?: readonly string[]
}

export interface QueryExecution {
  primaryQuery: LegalSearchQuery
  fallbackQueries: LegalSearchQuery[]
  fallbackTriggered: boolean
  fallbackTriggerReason: 'zero-results' | 'no-purpose-matching-results' | null
  attempts: {
    query: LegalSearchQuery
    retrievalId: string | null
    complete: boolean | null
    resultCount: number | null
    outcome: 'results' | 'zero-results' | 'provider-failure'
    execution: 'PROVIDER' | 'REUSED'
    requestIdentity: string | null
    reusedFromRetrievalId: string | null
  }[]
}

export async function retrieveWithFallback(
  plans: PlannedLegalSearchQuery[], retriever: LegalRetriever, onRequest: () => void,
  onProviderFailure?: (failure: ProviderFailure) => void,
  onReuse?: () => void,
  onAttempt?: (observation: RetrievalAttemptObservation) => void,
  options: RetrievalDispatchOptions = {},
) {
  const providerPlans = retriever.formulateQueryPlans?.(plans, options.legalQuestions) ?? plans
  const providerFailures: ProviderFailure[] = []
  const retrievedQueries: { query: LegalSearchQuery; retrieval: LegalRetrievalResult }[] = []
  const queryExecutions: QueryExecution[] = providerPlans.map(({ fallbackQueries, fallbackRejections: _rejections, ...primaryQuery }) => ({
    primaryQuery,
    fallbackQueries: primaryQuery.sourcePurpose === 'REFERENCE'
      ? fallbackQueries.map(query => ({ ...query, sourcePurpose: 'REFERENCE' })) : fallbackQueries,
    fallbackTriggered: false, fallbackTriggerReason: null, attempts: [],
  }))
  const unexecutedQueries: UnexecutedQuery[] = []
  const merged = new Map<string, { candidate: CandidateLegalSource; retrievalIds: string[] }>()
  const reusable = new Map<string, LegalRetrievalResult>()
  const statistics = { logicalQueryCount: 0, providerCallCount: 0, reusedQueryCount: 0 }
  const authorityPlans = providerPlans.filter(plan => plan.sourcePurpose !== 'REFERENCE')
  const referencePlans = providerPlans.filter(plan => plan.sourcePurpose === 'REFERENCE')
  const planByQuestion = new Map(authorityPlans.map(plan => [plan.legalQuestionId, plan.id]))
  const requiredIds = options.requiredLegalQuestionIds ?? authorityPlans.map(plan => plan.legalQuestionId)
  const questionCoverage: QuestionQueryCoverage[] = requiredIds.map(legalQuestionId => {
    const legalSearchQueryId = planByQuestion.get(legalQuestionId)
    return legalSearchQueryId
      ? { legalQuestionId, status: 'PLANNED', legalSearchQueryId }
      : { legalQuestionId, status: 'MISSING' }
  })
  let sequence = 0
  let referenceProviderCalls = 0

  type PlanState = {
    execution: QueryExecution
    unique: Set<string>
    primaryOutcome: 'PENDING' | 'ZERO_RESULTS' | 'STOPPED' | 'NOT_EXECUTED'
  }
  const states: PlanState[] = queryExecutions.map((execution) => ({
    execution, unique: new Set<string>(), primaryOutcome: 'PENDING',
  }))

  const markUnexecuted = (
    query: LegalSearchQuery,
    queryKind: 'PRIMARY' | 'FALLBACK',
    fallbackIndex: number | undefined,
    reason: UnexecutedQuery['reason'],
    requestIdentityHash: string | null,
  ) => {
    unexecutedQueries.push({
      legalQuestionId: query.legalQuestionId, legalSearchQueryId: query.id, queryKind,
      ...(query.sourcePurpose === 'REFERENCE' ? { sourcePurpose: 'REFERENCE' as const } : {}),
      ...(fallbackIndex === undefined ? {} : { fallbackIndex }), reason,
    })
    observe(onAttempt, {
      sequence: ++sequence, legalQuestionId: query.legalQuestionId, legalSearchQueryId: query.id,
      queryKind, ...(fallbackIndex === undefined ? {} : { fallbackIndex }), requestIdentityHash,
      status: 'NOT_EXECUTED', stopReason: reason,
    })
  }

  const runQuery = async (
    state: PlanState,
    query: LegalSearchQuery,
    queryKind: 'PRIMARY' | 'FALLBACK',
    fallbackIndex?: number,
  ): Promise<'CONTINUE' | 'STOP' | 'NOT_EXECUTED'> => {
    const { execution, unique } = state
    const { primaryQuery } = execution
    const sourcePurpose = primaryQuery.sourcePurpose ?? 'AUTHORITY'
    const requestIdentity = retriever.requestIdentity?.(query)
    const requestIdentityHash = requestIdentity
      ? createHash('sha256').update(requestIdentity).digest('hex') : null
    const previous = requestIdentity ? reusable.get(requestIdentity) : undefined
    // ponytail: one optional reference provider call per run; raise only if measured research value warrants it.
    if (sourcePurpose === 'REFERENCE' && !previous && referenceProviderCalls >= 1) {
      markUnexecuted(query, queryKind, fallbackIndex, 'REFERENCE_BUDGET_EXHAUSTED', requestIdentityHash)
      return 'NOT_EXECUTED'
    }
    if (sourcePurpose === 'REFERENCE' && !previous && options.canStartReferenceProviderRequest
      && !options.canStartReferenceProviderRequest()) {
      markUnexecuted(query, queryKind, fallbackIndex, 'REFERENCE_BUDGET_EXHAUSTED', requestIdentityHash)
      return 'NOT_EXECUTED'
    }
    if (!previous && options.canStartProviderRequest && !options.canStartProviderRequest()) {
      markUnexecuted(query, queryKind, fallbackIndex, 'QUERY_BUDGET_EXHAUSTED', requestIdentityHash)
      return 'NOT_EXECUTED'
    }

    const attemptSequence = ++sequence
    statistics.logicalQueryCount++
    onRequest()
    observe(onAttempt, {
      sequence: attemptSequence, legalQuestionId: query.legalQuestionId, legalSearchQueryId: query.id,
      queryKind, ...(fallbackIndex === undefined ? {} : { fallbackIndex }), requestIdentityHash, status: 'STARTED',
    })

    let retrieval: LegalRetrievalResult
    let executionMode: 'PROVIDER' | 'REUSED' = 'PROVIDER'
    let reusedFromRetrievalId: string | null = null
    try {
      if (previous) {
        executionMode = 'REUSED'
        reusedFromRetrievalId = previous.retrievalId
        statistics.reusedQueryCount++
        onReuse?.()
        retrieval = reuseForQuery(previous, query)
      } else {
        statistics.providerCallCount++
        if (sourcePurpose === 'REFERENCE') referenceProviderCalls++
        retrieval = await retriever.retrieve(query)
        // Providers opt in through requestIdentity; partial results never become reusable.
        if (requestIdentity && retrieval.complete) reusable.set(requestIdentity, retrieval)
      }
    } catch (error) {
      if (hasErrorCode(error, 'BUDGET_EXCEEDED')) {
        observe(onAttempt, {
          sequence: attemptSequence, legalQuestionId: query.legalQuestionId, legalSearchQueryId: query.id,
          queryKind, ...(fallbackIndex === undefined ? {} : { fallbackIndex }), requestIdentityHash,
          status: 'BUDGET_BLOCKED', errorCode: 'BUDGET_EXCEEDED', stopReason: 'BUDGET_EXCEEDED',
        })
        throw error
      }
      const optionalResponseFailure = sourcePurpose === 'REFERENCE' && error instanceof RetrievalError
        && (error.code === 'INVALID_RESPONSE' || (error.code === 'PROVIDER_ERROR' && error.cause === undefined))
      if (!isRecoverableRetrievalError(error) && !optionalResponseFailure) {
        observe(onAttempt, {
          sequence: attemptSequence, legalQuestionId: query.legalQuestionId, legalSearchQueryId: query.id,
          queryKind, ...(fallbackIndex === undefined ? {} : { fallbackIndex }), requestIdentityHash,
          status: 'PROVIDER_FAILURE', stopReason: 'PROVIDER_FAILURE',
          ...(error instanceof RetrievalError ? { errorCode: error.code } : {}),
        })
        throw error
      }
      if (!(error instanceof RetrievalError)) throw error
      const failure: ProviderFailure = {
        providerId: retriever.providerIdForQuery?.(query) ?? retriever.providerId ?? 'unknown-provider', query,
        errorCode: error.code, message: error.message,
        fallbackAttempted: query.id !== primaryQuery.id, retrievalDegraded: sourcePurpose !== 'REFERENCE',
      }
      providerFailures.push(failure)
      execution.attempts.push({
        query, retrievalId: null, complete: null, resultCount: null, outcome: 'provider-failure',
        execution: 'PROVIDER', requestIdentity: requestIdentity ?? null, reusedFromRetrievalId: null,
      })
      observe(onAttempt, {
        sequence: attemptSequence, legalQuestionId: query.legalQuestionId, legalSearchQueryId: query.id,
        queryKind, ...(fallbackIndex === undefined ? {} : { fallbackIndex }), requestIdentityHash,
        status: 'PROVIDER_FAILURE', errorCode: error.code, stopReason: 'PROVIDER_FAILURE',
      })
      onProviderFailure?.(failure)
      // Query rewriting cannot repair an unavailable provider. Later plans may recover.
      return 'STOP'
    }

    retrievedQueries.push({ query, retrieval })
    execution.attempts.push({
      query, retrievalId: retrieval.retrievalId, complete: retrieval.complete, resultCount: retrieval.sources.length,
      outcome: retrieval.sources.length ? 'results' : 'zero-results', execution: executionMode,
      requestIdentity: requestIdentity ?? null, reusedFromRetrievalId,
    })
    for (const candidate of retrieval.sources) {
      if (isReferenceCase(candidate) === (sourcePurpose === 'REFERENCE')) unique.add(candidate.sourceId)
      const existing = merged.get(candidate.sourceId)
      if (existing) existing.retrievalIds.push(retrieval.retrievalId)
      else merged.set(candidate.sourceId, { candidate, retrievalIds: [retrieval.retrievalId] })
    }
    const stopReason = queryKind === 'PRIMARY' && unique.size ? 'PRIMARY_RESULTS'
      : unique.size >= 5 ? 'SOURCE_TARGET_REACHED'
        : queryKind === 'PRIMARY' && execution.fallbackQueries.length === 0 ? 'QUERY_PLAN_EXHAUSTED'
        : queryKind === 'FALLBACK' && fallbackIndex === execution.fallbackQueries.length
          ? 'QUERY_PLAN_EXHAUSTED' : undefined
    observe(onAttempt, {
      sequence: attemptSequence, legalQuestionId: query.legalQuestionId, legalSearchQueryId: query.id,
      queryKind, ...(fallbackIndex === undefined ? {} : { fallbackIndex }), requestIdentityHash,
      status: executionMode === 'REUSED' ? 'REUSED' : 'PROVIDER_COMPLETED', complete: retrieval.complete,
      resultCount: retrieval.sources.length, ...(retrieval.access ? { cacheStatus: retrieval.access.cacheStatus } : {}),
      ...(reusedFromRetrievalId ? { reusedFromRetrievalId } : {}), ...(stopReason ? { stopReason } : {}),
    })
    if (queryKind === 'PRIMARY') {
      if (unique.size) return 'STOP'
      execution.fallbackTriggered = true
      execution.fallbackTriggerReason = retrieval.sources.length ? 'no-purpose-matching-results' : 'zero-results'
    }
    return unique.size >= 5 ? 'STOP' : 'CONTINUE'
  }

  const importance = options.importanceByLegalQuestionId
  for (const purpose of ['AUTHORITY', 'REFERENCE'] as const) {
    for (const level of ['HIGH', 'MEDIUM', 'LOW'] as const) {
      const tier = states.filter(({ execution }) =>
        (execution.primaryQuery.sourcePurpose ?? 'AUTHORITY') === purpose
        && (importance?.get(execution.primaryQuery.legalQuestionId) ?? 'MEDIUM') === level)
      for (const state of tier) {
        const outcome = await runQuery(state, state.execution.primaryQuery, 'PRIMARY')
        state.primaryOutcome = outcome === 'CONTINUE' ? 'ZERO_RESULTS'
          : outcome === 'NOT_EXECUTED' ? 'NOT_EXECUTED' : 'STOPPED'
      }
      const rounds = Math.max(0, ...tier.map(({ execution }) => execution.fallbackQueries.length))
      for (let fallbackOffset = 0; fallbackOffset < rounds; fallbackOffset++) {
        for (const state of tier) {
          const query = state.execution.fallbackQueries[fallbackOffset]
          if (!query) continue
          if (state.primaryOutcome === 'NOT_EXECUTED') {
            const requestIdentity = retriever.requestIdentity?.(query)
            markUnexecuted(query, 'FALLBACK', fallbackOffset + 1, 'PRIMARY_NOT_EXECUTED', requestIdentity
              ? createHash('sha256').update(requestIdentity).digest('hex') : null)
            continue
          }
          if (state.primaryOutcome !== 'ZERO_RESULTS') continue
          const outcome = await runQuery(state, query, 'FALLBACK', fallbackOffset + 1)
          if (outcome === 'STOP') state.primaryOutcome = 'STOPPED'
        }
      }
    }
  }

  // Execution availability is separate from provider result-set completeness.
  const authorityFailures = providerFailures.filter(item => item.query.sourcePurpose !== 'REFERENCE')
  const authorityRetrieved = retrievedQueries.some(item => item.query.sourcePurpose !== 'REFERENCE')
  const retrievalStatus: RetrievalStatus = authorityPlans.length === 0 ? 'FAILED'
    : questionCoverage.some(item => item.status === 'MISSING')
      || unexecutedQueries.some(item => item.sourcePurpose !== 'REFERENCE') ? 'DEGRADED'
    : authorityFailures.length === 0 ? 'COMPLETE'
      : !authorityRetrieved ? 'FAILED' : 'DEGRADED'
  const referenceCaseStatus: ReferenceCaseStatus = retrievedQueries.some(({ retrieval }) =>
    retrieval.sources.some(source => isReferenceCase(source))) ? 'FOUND'
    : !referencePlans.length ? 'NOT_SEARCHED'
      : unexecutedQueries.some(item => item.sourcePurpose === 'REFERENCE') ? 'BUDGET_EXHAUSTED'
        : providerFailures.some(item => item.query.sourcePurpose === 'REFERENCE') ? 'SEARCH_FAILED'
          : 'NO_REFERENCE_CASE_FOUND'
  return {
    retrievedQueries, queryExecutions, mergedSources: [...merged.values()], providerFailures,
    unexecutedQueries, questionCoverage, retrievalStatus, referenceCaseStatus, statistics,
  }
}

function observe(
  observer: ((observation: RetrievalAttemptObservation) => void) | undefined,
  observation: RetrievalAttemptObservation,
): void {
  try { observer?.(observation) } catch { /* Diagnostics must never alter research execution. */ }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function reuseForQuery(original: LegalRetrievalResult, query: LegalSearchQuery): LegalRetrievalResult {
  const reused = structuredClone(original)
  return {
    ...reused,
    retrievalId: `retrieval-${randomUUID()}`,
    legalQuestionId: query.legalQuestionId,
    legalSearchQueryId: query.id,
    retrievedAt: new Date().toISOString(),
  }
}
