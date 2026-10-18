import { createHash } from 'node:crypto'
import { z } from 'zod'

const nonBlank = z.string().refine(value => value.trim().length > 0, 'Must not be blank')
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && !value.startsWith('0000')
}, 'Must be an actual calendar date')
const officialUrl = z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
}, 'Official URL must be HTTPS without credentials or a custom port')

export const authorityDocumentTypeSchema = z.enum([
  'STATUTE', 'ADMINISTRATIVE_REGULATION', 'JUDICIAL_INTERPRETATION', 'NORMATIVE_DOCUMENT',
])
export const authorityValidityStatusSchema = z.enum(['EFFECTIVE', 'REPEALED', 'NOT_YET_EFFECTIVE', 'UNKNOWN'])
export const authoritySourceConfigSchema = z.strictObject({
  id: identifier,
  hosts: z.array(z.string().regex(/^[a-z0-9.-]+\.gov\.cn$/)).min(1),
  documentTypes: z.array(authorityDocumentTypeSchema).min(1),
  acquisitionMode: z.enum(['AUTOMATIC', 'MANUAL_ONLY']).optional(),
})
export type AuthoritySourceConfig = z.infer<typeof authoritySourceConfigSchema>

export const authorityValidityEvidenceSchema = z.strictObject({
  officialUrl,
  checkedAt: z.string().datetime(),
  excerpt: nonBlank,
  method: z.enum(['OFFICIAL_METADATA', 'CONTROLLED_REVIEW']),
  reason: nonBlank,
})
export const authorityDocumentInputSchema = z.strictObject({
  id: identifier,
  title: nonBlank,
  documentType: authorityDocumentTypeSchema,
  issuingAuthority: nonBlank,
  promulgatedAt: date.nullable(),
  effectiveAt: date.nullable(),
  validityStatus: authorityValidityStatusSchema,
  officialUrl,
  fetchedAt: z.string().datetime(),
  sourceId: identifier,
  validityEvidence: authorityValidityEvidenceSchema.optional(),
}).superRefine((document, context) => {
  if (document.validityStatus !== 'UNKNOWN' && !document.validityEvidence) {
    context.addIssue({ code: 'custom', message: 'Known validity requires explicit official evidence or controlled review' })
  }
  const evidence = document.validityEvidence
  if (evidence && evidence.officialUrl !== document.officialUrl) {
    context.addIssue({ code: 'custom', message: 'Validity evidence must identify this official snapshot' })
  }
  if (evidence && document.validityStatus === 'EFFECTIVE'
    && (!document.effectiveAt || document.effectiveAt > evidence.checkedAt.slice(0, 10))) {
    context.addIssue({ code: 'custom', message: 'Effective status needs an already-effective date at review time' })
  }
})
export type AuthorityDocumentInput = z.infer<typeof authorityDocumentInputSchema>

export const authorityDocumentMetadataSchema = authorityDocumentInputSchema.safeExtend({
  contentHash: hash,
  snapshotHash: hash,
  snapshotPath: nonBlank,
  snapshotFormat: z.enum(['HTML', 'TEXT']),
})
export const authorityDocumentSchema = authorityDocumentMetadataSchema.safeExtend({ bodyText: nonBlank.max(4_000_000) })
export type AuthorityDocument = z.infer<typeof authorityDocumentSchema>
export const authorityArticleSchema = z.strictObject({
  id: identifier,
  documentId: identifier,
  articleNumber: nonBlank,
  heading: z.string(),
  text: nonBlank,
  textHash: hash,
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).refine(article => article.end - article.start === article.text.length, 'Article offsets must match exact text length')
export type AuthorityArticle = z.infer<typeof authorityArticleSchema>
export const authorityArticleProvenanceSchema = z.strictObject({
  document: authorityDocumentMetadataSchema,
  article: authorityArticleSchema,
}).superRefine((provenance, context) => {
  if (provenance.article.documentId !== provenance.document.id) {
    context.addIssue({ code: 'custom', message: 'Article must belong to the provenance document' })
  }
})
export type AuthorityArticleProvenance = z.infer<typeof authorityArticleProvenanceSchema>

export const authorityImportSchema = z.strictObject({
  document: authorityDocumentInputSchema,
  bodyText: nonBlank.max(4_000_000),
  snapshot: z.strictObject({ content: nonBlank.max(12_000_000), format: z.enum(['HTML', 'TEXT']) }),
})
export type AuthorityImport = z.infer<typeof authorityImportSchema>
export const authoritySearchSchema = z.strictObject({
  query: nonBlank.max(4000),
  /** Canonical primary task text, separate from the query+keywords+concepts FTS bag. */
  taskQuery: nonBlank.max(4000).optional(),
  legalQuestion: nonBlank.max(8000).optional(),
  topK: z.number().int().min(1).max(30).default(8),
  documentTypes: z.array(authorityDocumentTypeSchema).min(1).optional(),
  validityStatuses: z.array(authorityValidityStatusSchema).min(1).optional(),
})
export type AuthoritySearchInput = z.input<typeof authoritySearchSchema>
export interface AuthoritySearchHit {
  document: AuthorityDocument
  article: AuthorityArticle
  score: number
  match: {
    providerQuery: string
    tokens: string[]
    matchedTokens: string[]
    relevanceAnchors: string[]
    queryCoverage: number
    questionCoverage: number
    relevanceSufficient: boolean
  }
}
export const authorityHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
