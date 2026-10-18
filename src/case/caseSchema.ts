import { z } from 'zod'

export const factCertaintySchema = z.enum(['CONFIRMED', 'USER_CLAIM', 'DISPUTED', 'UNKNOWN'])
export type FactCertainty = z.infer<typeof factCertaintySchema>

export const factCategorySchema = z.enum([
  'PARTY',
  'CONTRACT',
  'PAYMENT',
  'SERVICE',
  'EVENT',
  'COMMUNICATION',
  'DISPUTE',
  'TERMINATION',
  'OTHER',
])
export type FactCategory = z.infer<typeof factCategorySchema>

const factFields = {
  id: z.string().min(1),
  content: z.string().min(1),
  category: factCategorySchema,
  certainty: factCertaintySchema,
  source: z.literal('USER_INPUT'),
}

export const factSchema = z.object(factFields)
export type Fact = z.infer<typeof factSchema>

export const disputedFactSchema = z.object({
  ...factFields,
  certainty: z.literal('DISPUTED'),
})
export type DisputedFact = z.infer<typeof disputedFactSchema>

export const eventSchema = z.object({
  id: z.string().min(1),
  date: z.string().min(1).optional(),
  description: z.string().min(1),
  relatedFactIds: z.array(z.string().min(1)),
})
export type Event = z.infer<typeof eventSchema>

export const unknownFactSchema = z.object({
  question: z.string().min(1),
  importance: z.enum(['LOW', 'MEDIUM', 'HIGH']),
})
export type UnknownFact = z.infer<typeof unknownFactSchema>

export const caseSchema = z.object({
  id: z.string().min(1),
  facts: z.array(factSchema),
  events: z.array(eventSchema),
  disputedFacts: z.array(disputedFactSchema),
  unknownFacts: z.array(unknownFactSchema),
}).superRefine((value, context) => {
  const seen = new Set<string>()
  for (const [collection, facts] of [['facts', value.facts], ['disputedFacts', value.disputedFacts]] as const) {
    for (const [index, fact] of facts.entries()) {
      if (seen.has(fact.id)) {
        context.addIssue({
          code: 'custom', path: [collection, index, 'id'],
          message: 'Fact IDs must be unique across facts and disputedFacts',
        })
      }
      seen.add(fact.id)
    }
  }
})
export type Case = z.infer<typeof caseSchema>
