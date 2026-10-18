import { z } from 'zod'
import { createHash } from 'node:crypto'
import { ModelClientError } from '../llm/modelClient.js'
import { LegalQueryError } from '../legalQuery/legalQueryError.js'
import { AcceptanceBudgetError } from './acceptanceBudget.js'
import { FactExtractionError } from '../extraction/factExtractor.js'
import { ClassificationError } from '../classification/classificationError.js'
import { LegalQuestionError } from '../legalQuestion/legalQuestionError.js'
import { RetrievalError } from '../retrieval/retrievalError.js'
import { SourceVerificationError } from '../verification/sourceVerificationError.js'
import { SiteAccessError } from '../http/siteAccess.js'
import type { RetrievalAttemptObservation } from '../retrieval/queryFallback.js'
import { queryDomainDiagnosticSchema } from '../legalQuery/queryDomainDiagnostic.js'

const queryField = z.enum(['legalQuestionId', 'query', 'keywords', 'legalConcepts', 'searchIntent', 'fallbackQueries'])
const requestMetadata = z.object({ stage: z.literal('ENTAILMENT'),
  targetIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)).max(160),
  model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/), maxTokens: z.number().int().positive().max(50_000),
  temperature: z.number().finite().min(0).max(2).optional(),
}).optional()
const providerDiagnosticSchema = z.discriminatedUnion('failureKind', [
  z.object({
    requestMetadata,
    failureKind: z.literal('PROVIDER_TRANSPORT'),
    phase: z.enum(['FETCH', 'READ_RESPONSE', 'VALIDATE_RESPONSE']),
    responseReceived: z.boolean(), jsonParsed: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    attempt: z.number().int().min(1).max(2), durationMs: z.number().finite().nonnegative(),
    errorType: z.enum(['Error', 'TypeError', 'DOMException', 'OTHER']),
    networkCode: z.enum(['UNKNOWN', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
      'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']),
  }),
  z.object({ requestMetadata, failureKind: z.literal('PROVIDER_HTTP'), httpStatus: z.number().int().min(100).max(599) }),
  z.object({ requestMetadata, failureKind: z.literal('PROVIDER_RESPONSE'), responseIssue: z.enum([
    'INVALID_JSON', 'MISSING_CONTENT', 'EMPTY_CONTENT', 'OUTPUT_LIMIT_NO_CONTENT', 'INVALID_STRUCTURE',
    'UNSUPPORTED_CONTENT_TYPE', 'INVALID_CONTENT_LENGTH', 'RESPONSE_TOO_LARGE', 'MISSING_BODY', 'INVALID_UTF8',
  ]), responseMetadata: z.object({
    choiceCount: z.number().int().min(0).max(1000),
    messagePresent: z.boolean(),
    contentKind: z.enum(['MISSING', 'NULL', 'STRING', 'ARRAY', 'OTHER']),
    finishReason: z.enum(['MISSING', 'STOP', 'LENGTH', 'CONTENT_FILTER', 'TOOL_CALLS', 'FUNCTION_CALL',
      'INSUFFICIENT_SYSTEM_RESOURCE', 'OTHER']),
    reasoningContentPresent: z.boolean(),
    finalAnswerPresent: z.boolean().optional(), finalAnswerJsonParsed: z.boolean().optional(),
    contentCharacters: z.number().int().nonnegative().max(2_000_000).optional(),
    reasoningCharacters: z.number().int().nonnegative().max(2_000_000).optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    usage: z.object({
      promptTokens: z.number().int().nonnegative().optional(),
      completionTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
      promptCacheHitTokens: z.number().int().nonnegative().optional(),
      promptCacheMissTokens: z.number().int().nonnegative().optional(),
    }).optional(),
  }).optional() }),
])
const queryRuleId = z.enum([
  'LEGAL_CITATION', 'WIN_PREDICTION', 'LEGAL_CONCLUSION', 'UNGROUNDED_FACT',
  'MULTIPLE_PRIMARY_QUERIES', 'FALLBACK_WHITESPACE', 'FALLBACK_NOT_IN_QUESTION', 'FALLBACK_DUPLICATE',
  'HIGH_PRIMARY_MISSING_DOMAIN_ANCHOR',
])
const modelJsonDiagnosticSchema = z.object({ failureKind: z.literal('MODEL_JSON_PARSE') })
const querySchemaDiagnosticSchema = z.object({ failureKind: z.literal('QUERY_SCHEMA'), issues: z.array(z.object({
    path: z.array(z.union([z.string().regex(/^(queries|legalQuestionId|query|keywords|legalConcepts|searchIntent|fallbackQueries)$/),
      z.number().int().nonnegative()])).max(8),
    code: z.enum(['invalid_type', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of',
      'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom']),
  })).max(20) })
const queryBusinessDiagnosticSchema = z.object({
  failureKind: z.literal('QUERY_BUSINESS_RULE'), ruleId: queryRuleId,
  legalQuestionId: z.string().regex(/^question-[1-9]\d{0,9}$/).optional(),
  coverageStatus: z.literal('REJECTED').optional(), field: queryField,
})
const queryDiagnosticSchema = z.discriminatedUnion('failureKind', [
  modelJsonDiagnosticSchema, querySchemaDiagnosticSchema, queryBusinessDiagnosticSchema,
])
const acceptanceQueryDiagnosticSchema = z.discriminatedUnion('failureKind', [
  modelJsonDiagnosticSchema, querySchemaDiagnosticSchema, queryBusinessDiagnosticSchema.extend({
    legalQuestionText: z.string().min(1).max(4000).optional(),
    rawQueryDraft: z.string().min(1).max(4000).optional(),
    formulatedQuery: z.string().min(1).max(4000).optional(),
    detectedDomainAnchors: z.array(z.string().min(1).max(100)).max(20).optional(),
    detectedDisputeAnchors: z.array(z.string().min(1).max(100)).max(20).optional(),
    rejectionRuleId: queryRuleId.optional(),
    domainDiagnostic: queryDomainDiagnosticSchema.optional(),
  }),
])
const reliefDiagnosticSchema = z.strictObject({
  failureKind: z.literal('RELIEF_COVERAGE'), ruleId: z.literal('MISSING_RELIEF_COVERAGE'),
  missingReliefs: z.array(z.strictObject({
    reliefId: z.string().regex(/^relief-[1-9]\d*$/),
    action: z.enum(['RETURN_GOODS', 'RETURN_MONEY', 'PAY', 'COMPENSATE', 'TERMINATE', 'PERFORM', 'CEASE']),
    requestTextHash: z.string().regex(/^[a-f0-9]{64}$/),
    relatedFactIds: z.array(z.string()).max(20),
  })).min(1).max(20),
})

export type ProviderFailureDiagnostic = z.infer<typeof providerDiagnosticSchema>
export type QueryFailureDiagnostic = z.infer<typeof acceptanceQueryDiagnosticSchema>
export type FailureDiagnostic = ProviderFailureDiagnostic | QueryFailureDiagnostic
  | z.infer<typeof reliefDiagnosticSchema> | { failureKind: 'UNKNOWN' }

/** Persistence boundary: never serialize an Error, its message, cause, stack or arbitrary properties. */
export function safeFailureDiagnostic(error: unknown): FailureDiagnostic {
  if (error instanceof LegalQuestionError && error.message === 'MISSING_RELIEF_COVERAGE'
    && error.reliefCoverage) {
    const candidate = { failureKind: 'RELIEF_COVERAGE', ruleId: 'MISSING_RELIEF_COVERAGE',
      missingReliefs: error.reliefCoverage.filter(item => item.status === 'MISSING').map(item => ({
        reliefId: item.reliefId, action: item.action,
        requestTextHash: createHash('sha256').update(item.requestText).digest('hex'),
        relatedFactIds: item.relatedFactIds.map(id => /^(?:fact|dispute)-[1-9]\d*$/.test(id)
          ? id : `sha256:${createHash('sha256').update(id).digest('hex')}`),
      })) }
    const parsed = reliefDiagnosticSchema.safeParse(candidate)
    return parsed.success ? parsed.data : { failureKind: 'UNKNOWN' }
  }
  const schema = error instanceof ModelClientError ? providerDiagnosticSchema
    : error instanceof LegalQueryError ? queryDiagnosticSchema : undefined
  if (!schema || !(error instanceof ModelClientError || error instanceof LegalQueryError)) return { failureKind: 'UNKNOWN' }
  const result = schema.safeParse(error.diagnostic)
  return result.success ? result.data : { failureKind: 'UNKNOWN' }
}

/** Acceptance artifacts may retain bounded query context; ordinary logs stay redacted. */
export function safeAcceptanceFailureDiagnostic(error: unknown): FailureDiagnostic {
  if (!(error instanceof LegalQueryError)) return safeFailureDiagnostic(error)
  const result = acceptanceQueryDiagnosticSchema.safeParse(error.diagnostic)
  return result.success ? result.data : { failureKind: 'UNKNOWN' }
}

const publicCodes = z.enum(['INVALID_INPUT', 'INVALID_RESPONSE', 'CONFIG_ERROR', 'AUTH_ERROR', 'TIMEOUT',
  'CANCELLED', 'RATE_LIMIT', 'UPSTREAM_ERROR', 'BUDGET_EXCEEDED', 'DEADLINE_EXCEEDED', 'PROVIDER_ERROR',
  'NETWORK_ERROR', 'HTTP_SERVER_ERROR', 'ACCESS_RESTRICTED', 'UNSUPPORTED_PROVIDER', 'INTERNAL_ERROR'])

export function safeDiagnosticCode(code: unknown): string {
  const result = publicCodes.safeParse(code)
  return result.success ? result.data : 'UNKNOWN_ERROR'
}

export function safeErrorCode(error: unknown): string {
  if (!(error instanceof ModelClientError || error instanceof LegalQueryError || error instanceof AcceptanceBudgetError
    || error instanceof FactExtractionError || error instanceof ClassificationError || error instanceof LegalQuestionError
    || error instanceof RetrievalError || error instanceof SourceVerificationError || error instanceof SiteAccessError)) return 'UNKNOWN_ERROR'
  return safeDiagnosticCode(error.code)
}

export function summarizeUnexecutedQueries(attempts: RetrievalAttemptObservation[]) {
  return attempts.flatMap(item => item.status === 'NOT_EXECUTED'
    && (item.stopReason === 'QUERY_BUDGET_EXHAUSTED' || item.stopReason === 'PRIMARY_NOT_EXECUTED'
      || item.stopReason === 'REFERENCE_BUDGET_EXHAUSTED') ? [{
        legalQuestionId: item.legalQuestionId,
        legalSearchQueryId: item.legalSearchQueryId,
        queryKind: item.queryKind,
        ...(item.fallbackIndex === undefined ? {} : { fallbackIndex: item.fallbackIndex }),
        reason: item.stopReason,
      }] : [])
}
