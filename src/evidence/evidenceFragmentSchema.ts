import { z } from 'zod'
import { legalRuleEvidenceSchema, textLocatorSchema } from '../legalRule/legalRuleSchema.js'

const nonBlank = z.string().trim().min(1)

/** An exact passage in a verified source snapshot, not a legal conclusion. */
export const evidenceFragmentSchema = z.strictObject({
  fragmentId: nonBlank,
  ruleId: nonBlank,
  applicationIds: z.array(nonBlank),
  sourceId: nonBlank,
  verificationScope: z.literal('SOURCE_SNAPSHOT'),
  contentTrust: z.literal('UNTRUSTED'),
  source: legalRuleEvidenceSchema.shape.source,
  locator: textLocatorSchema,
}).superRefine((fragment, context) => {
  if (fragment.sourceId !== fragment.source.candidateSourceId) {
    context.addIssue({ code: 'custom', message: 'Fragment source ID differs from source provenance' })
  }
  if (new Set(fragment.applicationIds).size !== fragment.applicationIds.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate application IDs' })
  }
})

export type EvidenceFragment = z.infer<typeof evidenceFragmentSchema>
