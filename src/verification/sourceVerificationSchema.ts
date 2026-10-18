import { createHash } from 'node:crypto'
import { z } from 'zod'
import { legalRetrievalResultSchema, authorityMatchSchema } from '../retrieval/retrievalSchema.js'
import { legalSearchQuerySchema } from '../legalQuery/legalQuerySchema.js'
import { legalQuestionSchema } from '../legalQuestion/legalQuestionSchema.js'
import { authorityArticleProvenanceSchema, authorityDocumentTypeSchema } from '../authority/authoritySchema.js'

const nonBlank = z.string().refine((value) => value.trim().length > 0, 'Must not be blank')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && !value.startsWith('0000')
}, 'Must be an actual calendar date')
const snapshotUrl = z.string().regex(/^https:\/\/www\.court\.gov\.cn\/([a-z]+)\/xiangqing\/(\d+)\.html$/)
export const sourceVerificationRequestSchema = z.strictObject({
  retrieval: legalRetrievalResultSchema,
  candidateSourceId: nonBlank,
  query: legalSearchQuerySchema.optional(),
  legalQuestion: legalQuestionSchema.optional(),
}).superRefine((request, context) => {
  const retrieval = request.retrieval
  const ids = [retrieval.retrievalId, retrieval.legalQuestionId, retrieval.legalSearchQueryId, retrieval.providerId]
  if (request.query && (request.query.id !== retrieval.legalSearchQueryId || request.query.legalQuestionId !== retrieval.legalQuestionId)) {
    context.addIssue({ code: 'custom', message: 'Verification query contradicts retrieval provenance' })
  }
  if (request.legalQuestion && request.legalQuestion.id !== retrieval.legalQuestionId) {
    context.addIssue({ code: 'custom', message: 'Verification question contradicts retrieval provenance' })
  }
  if (ids.some((id) => !id.trim())) context.addIssue({ code: 'custom', message: 'Blank retrieval provenance' })
  if (new Set(retrieval.sources.map((source) => source.sourceId)).size !== retrieval.sources.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate candidate source IDs in retrieval' })
  }
  if (retrieval.sources.filter((source) => source.sourceId === request.candidateSourceId).length !== 1) {
    context.addIssue({ code: 'custom', message: 'Candidate must belong uniquely to the supplied retrieval' })
  }
})
export type SourceVerificationRequest = z.infer<typeof sourceVerificationRequestSchema>

export const verificationCheckSchema = z.strictObject({
  status: z.enum(['VERIFIED', 'MISMATCH', 'UNKNOWN', 'NOT_APPLICABLE']),
  reason: nonBlank,
})
export type VerificationCheck = z.infer<typeof verificationCheckSchema>
export const sourceVerificationChecksSchema = z.strictObject({
  existence: verificationCheckSchema,
  sourceIdentity: verificationCheckSchema,
  sourceOrigin: verificationCheckSchema,
  url: verificationCheckSchema,
  canonicalUrl: verificationCheckSchema,
  title: verificationCheckSchema,
  content: verificationCheckSchema,
  completeness: verificationCheckSchema,
  publicationDate: verificationCheckSchema,
  snippet: verificationCheckSchema,
  sourceType: verificationCheckSchema,
  legalStatus: verificationCheckSchema,
  relevance: verificationCheckSchema.optional(),
})
export type SourceVerificationChecks = z.infer<typeof sourceVerificationChecksSchema>

export const verificationEvidenceSchema = z.strictObject({
  requestedUrl: z.string().optional(),
  finalUrl: z.string().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  contentType: z.string().optional(),
  fetchedAt: z.string().datetime().optional(),
  cacheStatus: z.enum(['HIT', 'MISS']).optional(),
  cacheExpiresAt: z.string().datetime().optional(),
  responseBodyHash: hash.optional(),
  responseBytes: z.number().int().nonnegative().optional(),
  extractedProviderSourceId: nonBlank.optional(),
  redirects: z.array(z.strictObject({ url: z.string(), status: z.number().int(), location: z.string() })).max(3),
  parserId: nonBlank.optional(),
  parsedTitle: nonBlank.optional(),
  publicationDateRaw: z.array(z.string()).optional(),
  parsedPublicationDate: date.optional(),
  canonicalUrls: z.array(z.string()).optional(),
  contentHash: hash.optional(),
  contentLength: z.number().int().nonnegative().optional(),
  parserDiagnostics: z.strictObject({
    htmlTitle: z.string().max(500),
    pageType: z.enum(['DETAIL_STRUCTURE', 'SEARCH', 'UNKNOWN']),
    articleCandidateCount: z.number().int().nonnegative(),
    step: nonBlank,
  }).optional(),
  localCorpus: authorityArticleProvenanceSchema.optional(),
  relevanceMatch: authorityMatchSchema.optional(),
})
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>

/** VerifiedLegalSource means a verified SOURCE SNAPSHOT, not a verified legal
 * proposition, currently effective law, applicable law, Evidence or Citation.
 * Text remains UNTRUSTED. IDs link to the original candidate and this verification.
 */
export const verifiedLegalSourceSchema = z.strictObject({
  verificationScope: z.literal('SOURCE_SNAPSHOT'),
  contentTrust: z.literal('UNTRUSTED'),
  candidateSourceId: nonBlank,
  verificationId: nonBlank,
  verifiedAt: z.string().datetime(),
  providerSourceId: nonBlank,
  sourceUrl: z.string().url(),
  sourceOrigin: nonBlank,
  sourceType: z.union([z.literal('OTHER_LEGAL_MATERIAL'), authorityDocumentTypeSchema]),
  legalStatus: z.enum(['UNKNOWN', 'EFFECTIVE']),
  title: nonBlank,
  content: nonBlank,
  contentHash: hash,
  locator: z.enum(['FULL_DETAIL_PAGE_TEXT', 'AUTHORITY_ARTICLE_TEXT']),
  publicationDate: date.optional(),
  authority: authorityArticleProvenanceSchema.optional(),
}).superRefine((snapshot, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (snapshot.authority) {
    const { document, article } = snapshot.authority
    if (snapshot.providerSourceId !== article.id || snapshot.sourceUrl !== document.officialUrl
      || snapshot.sourceOrigin !== new URL(document.officialUrl).origin || snapshot.title !== document.title
      || snapshot.sourceType !== document.documentType || snapshot.legalStatus !== 'EFFECTIVE'
      || document.validityStatus !== 'EFFECTIVE' || snapshot.locator !== 'AUTHORITY_ARTICLE_TEXT'
      || snapshot.content !== article.text || snapshot.contentHash !== article.textHash
      || snapshot.publicationDate !== (document.promulgatedAt ?? undefined)) fail('Authority article snapshot differs from corpus provenance')
  } else {
    const identity = snapshotUrl.safeParse(snapshot.sourceUrl).success
      ? snapshot.sourceUrl.match(/^https:\/\/www\.court\.gov\.cn\/([a-z]+)\/xiangqing\/(\d+)\.html$/) : null
    if (!identity || identity[1] + ':' + identity[2] !== snapshot.providerSourceId) fail('Snapshot URL and provider identity differ')
    if (snapshot.sourceOrigin !== 'https://www.court.gov.cn' || snapshot.sourceType !== 'OTHER_LEGAL_MATERIAL'
      || snapshot.legalStatus !== 'UNKNOWN' || snapshot.locator !== 'FULL_DETAIL_PAGE_TEXT'
      || snapshot.content.length < 80 || snapshot.content.length > 50_000) fail('Court snapshot violates existing source policy')
  }
  const verifiedTime = Date.parse(snapshot.verifiedAt)
  if (snapshot.publicationDate && Number.isFinite(verifiedTime) && snapshot.publicationDate > new Date(verifiedTime + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)) {
    context.addIssue({ code: 'custom', message: 'Snapshot publication date is in the future' })
  }
  if (createHash('sha256').update(snapshot.content, 'utf8').digest('hex') !== snapshot.contentHash) {
    context.addIssue({ code: 'custom', message: 'Snapshot content hash does not match content' })
  }
})
export type VerifiedLegalSource = z.infer<typeof verifiedLegalSourceSchema>

export const minimumVerificationChecks = [
  'existence', 'sourceIdentity', 'sourceOrigin', 'url', 'title', 'content', 'completeness',
] as const
export function verificationStatusFromChecks(checks: SourceVerificationChecks): 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'FAILED' {
  if ([...minimumVerificationChecks, 'canonicalUrl' as const, 'sourceType' as const, 'legalStatus' as const].some((key) => checks[key].status === 'MISMATCH')
    || checks.relevance?.status === 'MISMATCH') return 'FAILED'
  if (checks.relevance && (checks.relevance.status !== 'VERIFIED' || checks.sourceType.status !== 'VERIFIED'
    || checks.legalStatus.status !== 'VERIFIED')) return 'PARTIALLY_VERIFIED'
  if (minimumVerificationChecks.every((key) => checks[key].status === 'VERIFIED')
    && checks.publicationDate.status !== 'MISMATCH') return 'VERIFIED'
  return 'PARTIALLY_VERIFIED'
}

export const sourceVerificationResultSchema = z.strictObject({
  verificationId: nonBlank,
  candidateSourceId: nonBlank,
  retrievalId: nonBlank,
  legalQuestionId: nonBlank,
  legalSearchQueryId: nonBlank,
  providerId: nonBlank,
  providerSourceId: nonBlank,
  status: z.enum(['VERIFIED', 'PARTIALLY_VERIFIED', 'FAILED', 'VERIFICATION_FAILED']),
  failure: z.strictObject({
    code: z.enum(['NETWORK_ERROR', 'ACCESS_RESTRICTED', 'TIMEOUT', 'INVALID_RESPONSE']),
    message: nonBlank,
  }).optional(),
  checkedAt: z.string().datetime(),
  checks: sourceVerificationChecksSchema,
  evidence: verificationEvidenceSchema,
  verifiedSource: verifiedLegalSourceSchema.optional(),
}).superRefine((result, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (result.status === 'VERIFICATION_FAILED') {
    if (Object.values(result.checks).some((check) => check.status !== 'UNKNOWN')) fail('Execution failure cannot assert verification checks')
    if (!result.failure || result.verifiedSource) fail('Execution failure requires diagnostics and forbids a snapshot')
  } else {
    if (result.failure) fail('Only execution failures may contain failure diagnostics')
    if (result.status !== verificationStatusFromChecks(result.checks)) fail('Overall status contradicts checks')
  }
  if ((result.status === 'VERIFIED') !== (result.verifiedSource !== undefined)) fail('Only VERIFIED results must contain a snapshot')
  const snapshot = result.verifiedSource
  if (!result.evidence.localCorpus && (result.checks.sourceType.status !== 'UNKNOWN' || result.checks.legalStatus.status !== 'UNKNOWN')) {
    fail('Court source verification cannot assert legal category or force')
  }
  if (!snapshot) return
  if (snapshot.candidateSourceId !== result.candidateSourceId || snapshot.verificationId !== result.verificationId
    || snapshot.providerSourceId !== result.providerSourceId || snapshot.verifiedAt !== result.checkedAt) fail('Snapshot provenance mismatch')
  const evidence = result.evidence
  if (snapshot.authority) {
    if (result.providerId !== 'local-authority-corpus-v1' || !evidence.localCorpus
      || JSON.stringify(evidence.localCorpus) !== JSON.stringify(snapshot.authority)
      || evidence.httpStatus !== undefined || evidence.contentType !== undefined
      || evidence.responseBodyHash !== snapshot.authority.document.snapshotHash
      || evidence.fetchedAt !== snapshot.authority.document.fetchedAt
      || !evidence.parserId || evidence.responseBytes === undefined || !evidence.relevanceMatch?.relevanceSufficient
      || result.checks.sourceType.status !== 'VERIFIED' || result.checks.legalStatus.status !== 'VERIFIED'
      || result.checks.relevance?.status !== 'VERIFIED') fail('Missing verified local corpus evidence')
  } else {
    if (evidence.localCorpus || evidence.httpStatus !== 200 || !evidence.responseBodyHash || !evidence.fetchedAt || !evidence.parserId
      || evidence.responseBytes === undefined) fail('Missing successful fetch evidence')
    if (!evidence.contentType || !/^text\/html(?:\s*;|$)/i.test(evidence.contentType)) fail('Missing HTML response evidence')
  }
  if (evidence.finalUrl !== snapshot.sourceUrl || evidence.extractedProviderSourceId !== snapshot.providerSourceId
    || evidence.parsedTitle !== snapshot.title || evidence.contentHash !== snapshot.contentHash
    || evidence.contentLength !== snapshot.content.length) fail('Snapshot differs from verification evidence')
  if (result.checks.canonicalUrl.status === 'VERIFIED' &&
    (evidence.canonicalUrls?.length !== 1 || !evidence.canonicalUrls[0])) fail('Missing canonical declaration evidence')
  if (result.checks.publicationDate.status === 'VERIFIED') {
    if (!snapshot.publicationDate || snapshot.publicationDate !== evidence.parsedPublicationDate) fail('Publication date missing or inconsistent')
  } else if (snapshot.publicationDate !== undefined) fail('Unverified publication date in snapshot')
})
export type SourceVerificationResult = z.infer<typeof sourceVerificationResultSchema>


export function unobservedVerificationChecks(): SourceVerificationChecks {
  const unknown = () => ({ status: 'UNKNOWN' as const, reason: 'Not observed yet' })
  return {
    existence: unknown(), sourceIdentity: unknown(), sourceOrigin: unknown(), url: unknown(),
    canonicalUrl: unknown(), title: unknown(), content: unknown(), completeness: unknown(),
    publicationDate: unknown(), snippet: unknown(),
    sourceType: { status: 'UNKNOWN', reason: 'No independent legal category verification in Step 9' },
    legalStatus: { status: 'UNKNOWN', reason: 'No current legal force, repeal or version verification in Step 9' },
  }
}

