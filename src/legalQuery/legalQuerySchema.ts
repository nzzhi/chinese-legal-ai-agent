import { z } from 'zod'

export const searchIntentSchema = z.enum([
  'LEGAL_RULE',
  'LEGAL_DEFINITION',
  'CONTRACT_RULE',
  'CONSUMER_PROTECTION',
  'PROCEDURE',
  'LIABILITY',
  'REMEDY',
  'OTHER',
])
export type SearchIntent = z.infer<typeof searchIntentSchema>

export const sourcePurposeSchema = z.enum(['AUTHORITY', 'REFERENCE'])
export type SourcePurpose = z.infer<typeof sourcePurposeSchema>

export const providerQueryFamilySchema = z.enum(['DOMAIN', 'DOMAIN_ACTION', 'AUTHORITY_FALLBACK'])
export type ProviderQueryFamily = z.infer<typeof providerQueryFamilySchema>

/**
 * 模型直接返回的结构：id 由程序生成，因此这里不包含 id。
 */
export const legalSearchQueryDraftSchema = z.object({
  legalQuestionId: z.string().min(1),
  query: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  legalConcepts: z.array(z.string().min(1)),
  searchIntent: searchIntentSchema,
  searchOnline: z.boolean().optional(),
  fallbackQueries: z.array(z.string().trim().min(2).max(8)).max(5),
})
export type LegalSearchQueryDraft = z.infer<typeof legalSearchQueryDraftSchema>

export const legalSearchQueryResponseSchema = z.object({
  queries: z.array(legalSearchQueryDraftSchema),
})
export type LegalSearchQueryResponse = z.infer<typeof legalSearchQueryResponseSchema>

export const legalSearchQuerySchema = z.object({
  id: z.string().min(1),
  legalQuestionId: z.string().min(1),
  // Legacy queries target legal rules. Reference searches must opt in explicitly.
  sourcePurpose: sourcePurposeSchema.optional(),
  searchOnline: z.boolean().optional(),
  /** Canonical query identity remains in query; adapters may add their actual request text here. */
  providerQuery: z.string().trim().min(1).optional(),
  providerQueryFamily: providerQueryFamilySchema.optional(),
  query: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  legalConcepts: z.array(z.string().min(1)),
  searchIntent: searchIntentSchema,
})
export type LegalSearchQuery = z.infer<typeof legalSearchQuerySchema>

export const fallbackQueryRejectionSchema = z.strictObject({
  fallbackIndex: z.number().int().positive(),
  reason: z.enum(['MISSING_DOMAIN_ANCHOR', 'MISSING_DISPUTE_ANCHOR']),
})
export type FallbackQueryRejection = z.infer<typeof fallbackQueryRejectionSchema>

export type PlannedLegalSearchQuery = LegalSearchQuery & {
  fallbackQueries: LegalSearchQuery[]
  /** Rejected model drafts are not executable queries and have no query ID or result count. */
  fallbackRejections?: FallbackQueryRejection[]
}
