import { createHash } from 'node:crypto'
import { caseSchema, type Case } from './caseSchema.js'
import { legalQuestionSchema, type LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'

export class StaleFactReferencesError extends Error {
  readonly code = 'STALE_FACT_REFERENCES'
  constructor() { super('STALE_FACT_REFERENCES: Case changed or question facts belong to another snapshot; regenerate LegalQuestion') }
}

// Schema ordering makes object property order immaterial; Fact/event array order remains part of identity.
export const caseSnapshotId = (value: Case) => 'case-snapshot-' + createHash('sha256')
  .update(JSON.stringify(caseSchema.parse(value))).digest('hex')

export function assertCaseSnapshot(value: Case, expected: string) {
  if (caseSnapshotId(value) !== expected) throw new StaleFactReferencesError()
}

export function assertQuestionFacts(value: Case, questions: LegalQuestion[], requireSnapshot = false) {
  const snapshot = caseSnapshotId(value)
  const known = new Set(value.facts.concat(value.disputedFacts).map(f => f.id))
  for (const q of questions) {
    if (q.relatedFactIds.some(id => !known.has(id)) || q.caseSnapshotId && q.caseSnapshotId !== snapshot
      || requireSnapshot && q.caseSnapshotId !== snapshot) throw new StaleFactReferencesError()
  }
}

/** Only call at the fresh decompose boundary, never to relabel a saved question. */
export function bindGeneratedQuestions(value: Case, questions: LegalQuestion[], expected: string) {
  assertCaseSnapshot(value, expected)
  assertQuestionFacts(value, questions)
  return questions.map(q => legalQuestionSchema.parse({ ...q, caseSnapshotId: expected }))
}
