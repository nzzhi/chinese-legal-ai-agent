import { z } from 'zod'
import { authorityArticleProvenanceSchema } from '../authority/authoritySchema.js'

const nonBlank = z.string().refine((value) => value.trim().length > 0, 'Must not be blank')

export const legalSourceTypeSchema = z.enum([
  'CONSTITUTION', 'STATUTE', 'LEGISLATIVE_INTERPRETATION', 'JUDICIAL_INTERPRETATION',
  'ADMINISTRATIVE_REGULATION', 'LOCAL_REGULATION', 'DEPARTMENT_RULE',
  'LOCAL_GOVERNMENT_RULE', 'NORMATIVE_DOCUMENT', 'GUIDING_CASE', 'TYPICAL_CASE',
  'ORDINARY_JUDGMENT', 'OTHER_LEGAL_MATERIAL',
])
export type LegalSourceType = z.infer<typeof legalSourceTypeSchema>

const sourceUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}, 'Source URL must be HTTP(S) without credentials')

export const responseAccessSchema = z.strictObject({
  cacheStatus: z.enum(['HIT', 'MISS']),
  storedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
})

/** All fields are provider-reported data, including title, type, origin and URL.
 * locator may identify an article/paragraph/item or a case passage; it is not verified.
 * providerSourceId must identify one corpus record/passage, not an entire multi-hit website.
 * score is a finite provider-specific ranking value, never confidence or legal authority.
 */
export const providerLegalSourceSchema = z.strictObject({
  providerSourceId: nonBlank,
  sourceType: legalSourceTypeSchema,
  title: nonBlank,
  content: nonBlank,
  sourceOrigin: nonBlank,
  sourceUrl: sourceUrlSchema.optional(),
  locator: nonBlank.optional(),
  retrievalScore: z.number().finite().optional(),
  authority: authorityArticleProvenanceSchema.optional(),
})
export type ProviderLegalSource = z.infer<typeof providerLegalSourceSchema>

export const authorityMatchSchema = z.strictObject({
  providerQuery: z.string(), tokens: z.array(z.string()), matchedTokens: z.array(z.string()),
  relevanceAnchors: z.array(z.string()), queryCoverage: z.number().min(0).max(1),
  questionCoverage: z.number().min(0).max(1), relevanceSufficient: z.boolean(),
})
const queryDiagnosticsSchema = z.strictObject({
  providerQuery: z.string(),
  matches: z.array(z.strictObject({ providerSourceId: nonBlank, match: authorityMatchSchema })),
})

/** complete describes the returned result set, not successful execution or corpus coverage.
 * false permits valid partial results (unfetched pages, result limits, or truncated text).
 * Missing/non-boolean flags and malformed sources are invalid; operational failures throw.
 */
export const retrievalProviderResponseSchema = z.strictObject({
  complete: z.boolean(),
  sources: z.array(providerLegalSourceSchema),
  access: responseAccessSchema.optional(),
  queryDiagnostics: queryDiagnosticsSchema.optional(),
})
export type RetrievalProviderResponse = z.infer<typeof retrievalProviderResponseSchema>

export const candidateLegalSourceSchema = z.strictObject({
  sourceId: nonBlank,
  verificationStatus: z.literal('UNVERIFIED'),
  contentTrust: z.literal('UNTRUSTED'),
  record: providerLegalSourceSchema,
})
export type CandidateLegalSource = z.infer<typeof candidateLegalSourceSchema>

export const legalRetrievalResultSchema = z.strictObject({
  retrievalId: nonBlank,
  legalQuestionId: nonBlank,
  legalSearchQueryId: nonBlank,
  providerId: nonBlank,
  retrievedAt: z.string().datetime(),
  // Preserve provider completeness after deduplication, including zero sources.
  complete: z.boolean(),
  access: responseAccessSchema.optional(),
  sources: z.array(candidateLegalSourceSchema),
  queryDiagnostics: queryDiagnosticsSchema.optional(),
})
export type LegalRetrievalResult = z.infer<typeof legalRetrievalResultSchema>

