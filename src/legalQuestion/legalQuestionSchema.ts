import { z } from 'zod'
import type { Case } from '../case/caseSchema.js'
import {
  analysisImportanceSchema,
  type ClassificationResult,
  type DisputeAnalysisResult,
} from '../classification/classificationSchema.js'

export const legalQuestionTypeSchema = z.enum([
  'CONTRACT_FORMATION',
  'CONTRACT_PERFORMANCE',
  'CONTRACT_TERMINATION',
  'REFUND',
  'STANDARD_TERMS',
  'DAMAGES',
  'PROCEDURE',
  'OTHER',
])
export type LegalQuestionType = z.infer<typeof legalQuestionTypeSchema>

/**
 * 模型直接返回的结构：id 由程序生成，因此这里不包含 id。
 */
export const legalQuestionDraftSchema = z.object({
  question: z.string().min(1),
  issueId: z.string().min(1),
  importance: analysisImportanceSchema,
  questionType: legalQuestionTypeSchema,
  relatedFactIds: z.array(z.string().min(1)),
})
export type LegalQuestionDraft = z.infer<typeof legalQuestionDraftSchema>

export const legalQuestionResponseSchema = z.object({
  questions: z.array(legalQuestionDraftSchema),
})
export type LegalQuestionResponse = z.infer<typeof legalQuestionResponseSchema>

export const legalQuestionSchema = z.object({
  id: z.string().min(1),
  caseSnapshotId: z.string().regex(/^case-snapshot-[a-f0-9]{64}$/).optional(),
  question: z.string().min(1),
  issueId: z.string().min(1),
  importance: analysisImportanceSchema,
  questionType: legalQuestionTypeSchema,
  relatedFactIds: z.array(z.string().min(1)),
})
export type LegalQuestion = z.infer<typeof legalQuestionSchema>

/**
 * Step 5 的输入：复用 Step 3 / Step 4 已有的结果类型，不重复定义平行结构。
 */
export interface LegalQuestionSource {
  /** Original user wording is authoritative for explicit requested reliefs. */
  rawCase?: string
  case: Case
  classification: ClassificationResult
  disputeAnalysis: DisputeAnalysisResult
}
