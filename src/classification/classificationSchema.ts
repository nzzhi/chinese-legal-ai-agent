import { z } from 'zod'

export const caseCategorySchema = z.enum([
  'CONSUMER_DISPUTE',
  'CONTRACT_DISPUTE',
  'SERVICE_DISPUTE',
  'LOAN_DISPUTE',
  'EMPLOYMENT_DISPUTE',
  'PROPERTY_DISPUTE',
  'TRAFFIC_DISPUTE',
  'PROPERTY_DAMAGE',
  'OTHER',
])
export type CaseCategory = z.infer<typeof caseCategorySchema>

export const analysisImportanceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW'])
export type AnalysisImportance = z.infer<typeof analysisImportanceSchema>

export const caseClassificationSchema = z.object({
  primary: caseCategorySchema,
  secondary: z.string().min(1).optional(),
  confidence: analysisImportanceSchema,
  reason: z.string().min(1),
})
export type CaseClassification = z.infer<typeof caseClassificationSchema>

export const classificationResultSchema = z.object({
  caseId: z.string().min(1),
  classification: caseClassificationSchema,
})
export type ClassificationResult = z.infer<typeof classificationResultSchema>

export const disputedFactAnalysisSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  userPosition: z.string().min(1).optional(),
  opposingPosition: z.string().min(1).optional(),
  relatedFactIds: z.array(z.string().min(1)),
})
export type DisputedFactAnalysis = z.infer<typeof disputedFactAnalysisSchema>

export const issueSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  importance: analysisImportanceSchema,
  relatedFactIds: z.array(z.string().min(1)),
})
export type Issue = z.infer<typeof issueSchema>

const issuesSchema = z.array(issueSchema).superRefine((issues, context) => {
  const seen = new Set<string>()
  for (const [index, issue] of issues.entries()) {
    if (seen.has(issue.id)) {
      context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Issue IDs must be unique' })
    }
    seen.add(issue.id)
  }
})

export const disputeAnalysisSchema = z.object({
  disputedFacts: z.array(disputedFactAnalysisSchema),
  issues: issuesSchema,
})
export type DisputeAnalysis = z.infer<typeof disputeAnalysisSchema>

export const disputeAnalysisResultSchema = disputeAnalysisSchema.extend({
  caseId: z.string().min(1),
})
export type DisputeAnalysisResult = z.infer<typeof disputeAnalysisResultSchema>
