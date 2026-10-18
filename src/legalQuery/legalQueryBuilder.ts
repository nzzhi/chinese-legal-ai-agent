import type { ModelClient } from '../llm/modelClient.js'
import type { ModelRouter } from '../llm/modelRouter.js'
import { parseModelJson } from '../llm/modelJson.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import { LegalQueryError, assertQueryTextSafe, queryRuleDiagnostic } from './legalQueryError.js'
import { buildLegalQueryMessagesFromContexts } from './legalQueryPrompt.js'
import { deriveDomainContext, hasContextDomainAnchor, hasContextDisputeAnchor, formulateContextPrimaryQuery,
  validatePrimaryDomainQuery } from './derivedDomainContext.js'
import { queryDomainDiagnosticSchema, type QueryDomainDiagnostic } from './queryDomainDiagnostic.js'
import {
  canonicalizeQueryFormulation,
} from './fallbackGrounding.js'
import {
  legalSearchQueryResponseSchema,
  type LegalSearchQuery,
  type PlannedLegalSearchQuery,
} from './legalQuerySchema.js'

export interface LegalQueryBuilder {
  build(questions: LegalQuestion[]): Promise<PlannedLegalSearchQuery[]>
}

// Zero-based positions in the original parsed response; never includes query text.
export interface FallbackDuplicateDiagnostic {
  event: 'FALLBACK_DEDUPLICATED'
  legalQuestionId?: string
  queryIndex: number
  fallbackIndex: number
  duplicateKind: 'PRIMARY' | 'FALLBACK'
  retainedFallbackIndex?: number
}

export class ModelLegalQueryBuilder implements LegalQueryBuilder {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly modelRouter: ModelRouter,
    private readonly createId: (index: number) => string = (index) => `query-${index + 1}`,
    private readonly onFallbackDuplicate?: (diagnostic: FallbackDuplicateDiagnostic) => void,
    private readonly onDomainDiagnostic?: (diagnostic: QueryDomainDiagnostic) => void,
  ) {}

  async build(questions: LegalQuestion[]): Promise<PlannedLegalSearchQuery[]> {
    if (questions.length === 0) {
      return []
    }

    const questionIds = new Set<string>()
    for (const question of questions) {
      if (questionIds.has(question.id)) {
        throw new LegalQueryError('INVALID_INPUT', `Duplicate legal question id: ${question.id}`)
      }
      questionIds.add(question.id)
    }

    const contexts = new Map(questions.map(question => [question.id, deriveDomainContext(question)]))
    const response = await this.modelClient.chat({
      model: this.modelRouter.getModel('FLASH'),
      messages: buildLegalQueryMessagesFromContexts([...contexts.values()], new Map(questions.map(q => [q.id, q.importance]))),
      temperature: 0,
    })

    let parsed: unknown
    try {
      parsed = parseModelJson(response.text)
    } catch (error) {
      throw new LegalQueryError('INVALID_RESPONSE', 'Legal query model returned invalid JSON', {
        cause: error,
        diagnostic: { failureKind: 'MODEL_JSON_PARSE' },
      })
    }

    const result = legalSearchQueryResponseSchema.safeParse(parsed)
    if (!result.success) {
      throw new LegalQueryError('INVALID_RESPONSE', 'Legal query output failed schema validation', {
        cause: result.error,
        diagnostic: { failureKind: 'QUERY_SCHEMA', issues: result.error.issues.slice(0, 20).map(issue => ({
          path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
          code: issue.code,
        })) },
      })
    }

    // Validate every known-question draft before any deduplication can discard it.
    for (const draft of result.data.queries) {
      const question = questions.find((item) => item.id === draft.legalQuestionId)
      if (!question) continue
      const ownText = question.question
      const context = contexts.get(question.id)!
      assertQueryTextSafe(draft.query, 'query', ownText, question.id)
      const formulated = formulateContextPrimaryQuery(draft.query, context, draft.searchIntent)
      assertQueryTextSafe(formulated, 'query', ownText, question.id)
      const validation = validatePrimaryDomainQuery(formulated, context, question.importance, draft.searchIntent)
      const rejected = !validation.valid
      const domainDiagnostic = queryDomainDiagnosticSchema.safeParse({
        legalQuestionId: question.id, legalQuestionText: ownText, questionType: question.questionType,
        importance: question.importance, searchIntent: draft.searchIntent, queryType: 'PRIMARY', sourcePurpose: 'AUTHORITY',
        questionAnchors: [...context.domainAnchors], normalizedDomains: context.normalizedDomains,
        rawQueryDraft: draft.query, formulatedQuery: formulated,
        finalQueryAnchors: validation.anchors,
        validationResult: rejected ? 'REJECTED' : 'PASS',
        validationReason: validation.reason,
        ...(rejected ? { ruleId: 'HIGH_PRIMARY_MISSING_DOMAIN_ANCHOR' } : {}),
      })
      if (domainDiagnostic.success) this.onDomainDiagnostic?.(domainDiagnostic.data)
      if (rejected) {
        throw new LegalQueryError('INVALID_RESPONSE', 'HIGH primary query must contain a domain anchor from its LegalQuestion', {
          diagnostic: queryRuleDiagnostic('HIGH_PRIMARY_MISSING_DOMAIN_ANCHOR', 'query', question.id, {
            legalQuestionText: ownText,
            rawQueryDraft: draft.query,
            formulatedQuery: formulated,
            detectedDomainAnchors: [...context.domainAnchors],
            detectedDisputeAnchors: [...context.disputeAnchors],
            ...(domainDiagnostic.success ? { domainDiagnostic: domainDiagnostic.data } : {}),
          }),
        })
      }
      for (const keyword of draft.keywords) {
        assertQueryTextSafe(keyword, 'keywords', ownText, question.id)
      }
      for (const concept of draft.legalConcepts) {
        assertQueryTextSafe(concept, 'legalConcepts', ownText, question.id)
      }
      const groundedExpressions = new Set(context.allowedFallbackExpressions)
      for (const fallback of draft.fallbackQueries) {
        assertQueryTextSafe(fallback, 'fallbackQueries', ownText, question.id)
        const grounded = ownText.includes(fallback) || groundedExpressions.has(fallback)
        if (/\s/.test(fallback) || !grounded) {
          throw new LegalQueryError('INVALID_RESPONSE', 'Fallback must be grounded in its own LegalQuestion or its allowed expressions', {
            diagnostic: queryRuleDiagnostic(/\s/.test(fallback) ? 'FALLBACK_WHITESPACE'
              : 'FALLBACK_NOT_IN_QUESTION', 'fallbackQueries', question.id),
          })
        }
      }
    }

    const seen = new Set<string>()
    const queries: PlannedLegalSearchQuery[] = []
    const diagnostics: FallbackDuplicateDiagnostic[] = []
    for (const [queryIndex, draft] of result.data.queries.entries()) {
      // 模型伪造的 legalQuestionId 一律丢弃，不允许影响 legalQuestionId → query 映射。
      if (!questionIds.has(draft.legalQuestionId)) {
        continue
      }

      const dedupeKey = `${draft.legalQuestionId}\u0000${draft.query.replace(/\s+/g, ' ').trim()}`
      if (seen.has(dedupeKey)) {
        continue
      }
      seen.add(dedupeKey)
      if (queries.some((query) => query.legalQuestionId === draft.legalQuestionId)) {
        throw new LegalQueryError('INVALID_RESPONSE', 'Only one primary query is allowed per legal question', {
          diagnostic: queryRuleDiagnostic('MULTIPLE_PRIMARY_QUERIES', 'query', draft.legalQuestionId),
        })
      }
      const question = questions.find(item => item.id === draft.legalQuestionId)!
      const context = contexts.get(question.id)!
      const primaryQuery = formulateContextPrimaryQuery(draft.query, context, draft.searchIntent)
      const fallbackSeen = new Map<string, number>([[canonicalizeQueryFormulation(primaryQuery), -1]])
      const fallbackRejections: NonNullable<PlannedLegalSearchQuery['fallbackRejections']> = []
      const fallbacks: string[] = []
      const groundedExpressions = new Set(context.allowedFallbackExpressions)
      for (const [fallbackIndex, fallback] of draft.fallbackQueries.entries()) {
        const formulated = canonicalizeQueryFormulation(fallback)
        const retainedIndex = fallbackSeen.get(formulated)
        if (retainedIndex !== undefined) {
          diagnostics.push({
            event: 'FALLBACK_DEDUPLICATED', queryIndex, fallbackIndex,
            ...(/^question-[1-9]\d{0,9}$/.test(draft.legalQuestionId) ? { legalQuestionId: draft.legalQuestionId } : {}),
            duplicateKind: retainedIndex === -1 ? 'PRIMARY' : 'FALLBACK',
            ...(retainedIndex === -1 ? {} : { retainedFallbackIndex: retainedIndex }),
          })
          continue
        }
        if (!hasContextDomainAnchor(formulated, context)) {
          fallbackRejections.push({ fallbackIndex: fallbackIndex + 1, reason: 'MISSING_DOMAIN_ANCHOR' })
          continue
        }
        if (!hasContextDisputeAnchor(formulated, context)) {
          fallbackRejections.push({ fallbackIndex: fallbackIndex + 1, reason: 'MISSING_DISPUTE_ANCHOR' })
          continue
        }
        if (!question.question.includes(formulated) && !groundedExpressions.has(formulated)) {
          throw new LegalQueryError('INVALID_RESPONSE', 'Canonical fallback must remain grounded in its own LegalQuestion', {
            diagnostic: queryRuleDiagnostic('FALLBACK_NOT_IN_QUESTION', 'fallbackQueries', question.id),
          })
        }
        fallbackSeen.set(formulated, fallbackIndex)
        fallbacks.push(formulated)
      }
      const primaryId = this.createId(queries.length)

      queries.push({
        id: primaryId,
        legalQuestionId: draft.legalQuestionId,
        query: primaryQuery,
        keywords: draft.keywords,
        legalConcepts: draft.legalConcepts,
        searchIntent: draft.searchIntent,
        ...(draft.searchOnline === undefined ? {} : { searchOnline:draft.searchOnline }),
        fallbackRejections,
        fallbackQueries: fallbacks.map((query, index): LegalSearchQuery => ({
          id: `${primaryId}-fallback-${index + 1}`, legalQuestionId: draft.legalQuestionId,
          query, keywords: [query], legalConcepts: [], searchIntent: draft.searchIntent,
        })),
      })
    }

    for (const diagnostic of diagnostics) this.onFallbackDuplicate?.(diagnostic)
    return queries
  }
}
