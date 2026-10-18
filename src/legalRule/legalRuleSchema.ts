import { z } from 'zod'
import { authorityArticleProvenanceSchema } from '../authority/authoritySchema.js'
import { ruleQualificationSchema } from './authorityQuestionGate.js'

const nonBlank = z.string().trim().min(1)
const hash = z.string().regex(/^[a-f0-9]{64}$/)

export const textLocatorSchema = z.strictObject({
  kind: z.literal('TEXT_OFFSET'),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: nonBlank,
  quoteHash: hash,
}).refine(locator => locator.end > locator.start, 'Locator end must follow start')

const unknownLegalStatusSchema = z.strictObject({
  status: z.literal('UNKNOWN'),
  reason: nonBlank,
})
const verifiedLegalStatusSchema = z.strictObject({
  status: z.literal('VERIFIED'),
  value: z.enum(['EFFECTIVE', 'NOT_YET_EFFECTIVE', 'REPEALED']),
  checkedAt: z.string().datetime(),
  authorityName: nonBlank,
  authorityUrl: z.string().url(),
  versionAt: z.string().date(),
})

export const legalRuleEvidenceSchema = z.strictObject({
  ruleId: nonBlank,
  legalName: nonBlank,
  article: nonBlank,
  ruleText: nonBlank,
  locator: textLocatorSchema,
  ruleTextVerification: z.strictObject({
    status: z.literal('VERIFIED'),
    method: z.literal('EXACT_SOURCE_QUOTE'),
  }),
  legalStatus: z.discriminatedUnion('status', [unknownLegalStatusSchema, verifiedLegalStatusSchema]),
  version: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('UNKNOWN'), reason: nonBlank }),
    z.strictObject({ status: z.literal('VERIFIED'), identifier: nonBlank, checkedAt: z.string().datetime(),
      authorityName: nonBlank, authorityUrl: z.string().url() }),
  ]),
  sourceEffectStatements: z.array(z.strictObject({
    text: nonBlank,
    effectiveDate: z.string().date().optional(),
    locator: textLocatorSchema,
    scope: z.literal('SOURCE_TEXT_ONLY'),
  })),
  qualification: ruleQualificationSchema.optional(),
  source: z.strictObject({
    candidateSourceId: nonBlank,
    verificationId: nonBlank,
    retrievalId: nonBlank,
    legalSearchQueryId: nonBlank,
    providerId: nonBlank,
    providerSourceId: nonBlank,
    sourceUrl: z.string().url(),
    sourceContentHash: hash,
    authority: authorityArticleProvenanceSchema.optional(),
  }),
}).superRefine((rule, context) => {
  const authority = rule.source.authority
  if (rule.qualification && (rule.qualification.assessment.applicability !== 'PASS'
    || rule.qualification.assessment.relevance !== 'PASS')) {
    context.addIssue({ code: 'custom', message: 'Rule qualification must pass both question-level gates' })
  }
  if (!authority) return
  const { document, article } = authority
  if (rule.legalName !== document.title || rule.article !== article.articleNumber
    || rule.ruleText !== article.text.slice(article.articleNumber.length).trim()
    || rule.locator.start !== 0 || rule.locator.end !== article.text.length || rule.locator.quote !== article.text
    || rule.source.providerSourceId !== article.id || rule.source.sourceUrl !== document.officialUrl
    || rule.source.sourceContentHash !== article.textHash || document.validityStatus !== 'EFFECTIVE') {
    context.addIssue({ code: 'custom', message: 'Authority rule differs from its verified complete article provenance' })
  }
})
export type LegalRuleEvidence = z.infer<typeof legalRuleEvidenceSchema>

const reviewedApplicationSchema = z.strictObject({
  method: z.literal('HUMAN_REVIEW'),
  reviewerId: nonBlank,
  reviewedAt: z.string().datetime(),
  analysis: nonBlank,
  conclusion: nonBlank,
})

export const legalRuleApplicationSchema = z.strictObject({
  applicationId: nonBlank,
  legalRuleId: nonBlank,
  legalQuestionId: nonBlank,
  legalSearchQueryId: nonBlank,
  retrievalId: nonBlank,
  relatedFactIds: z.array(nonBlank),
  evidenceGaps: z.array(nonBlank),
  status: z.enum(['UNKNOWN', 'VERIFIED_APPLICABLE', 'VERIFIED_NOT_APPLICABLE']),
  reason: nonBlank,
  assessment: reviewedApplicationSchema.optional(),
}).superRefine((application, context) => {
  if ((application.status === 'UNKNOWN') !== (application.assessment === undefined)) {
    context.addIssue({ code: 'custom', message: 'Only reviewed applications may assert applicability' })
  }
})
export type LegalRuleApplication = z.infer<typeof legalRuleApplicationSchema>
