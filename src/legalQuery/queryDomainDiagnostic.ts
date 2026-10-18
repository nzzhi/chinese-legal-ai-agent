import { z } from 'zod'
import { legalQuestionTypeSchema } from '../legalQuestion/legalQuestionSchema.js'
import { searchIntentSchema } from './legalQuerySchema.js'

const anchors = z.array(z.string().min(1).max(100)).max(40)
/** Private, bounded structured trace; never the model response, prompt, credentials or Error. */
export const queryDomainDiagnosticSchema = z.strictObject({
  legalQuestionId: z.string().min(1).max(100), legalQuestionText: z.string().min(1).max(4000),
  questionType: legalQuestionTypeSchema, importance: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  searchIntent: searchIntentSchema, queryType: z.literal('PRIMARY'), sourcePurpose: z.literal('AUTHORITY'),
  questionAnchors: anchors, normalizedDomains: z.array(z.strictObject({ canonical: z.string().min(1).max(100), aliases: anchors })).max(40),
  rawQueryDraft: z.string().min(1).max(4000), formulatedQuery: z.string().min(1).max(4000),
  finalQueryAnchors: anchors, validationResult: z.enum(['PASS', 'REJECTED']),
  validationReason: z.enum(['DOMAIN_RETAINED', 'NOT_HIGH', 'PROCEDURE_EXCEPTION',
    'QUESTION_DOMAIN_UNRECOGNIZED', 'FINAL_QUERY_DOMAIN_LOST']),
  ruleId: z.literal('HIGH_PRIMARY_MISSING_DOMAIN_ANCHOR').optional(),
})
export type QueryDomainDiagnostic = z.infer<typeof queryDomainDiagnosticSchema>
export const queryDomainAuditSchema = z.strictObject({
  runId: z.string().uuid(), recordedAt: z.string().datetime(),
  items: z.array(queryDomainDiagnosticSchema).max(100),
})
