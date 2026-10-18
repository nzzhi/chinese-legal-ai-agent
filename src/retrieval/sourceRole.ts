import type { CandidateLegalSource } from './retrievalSchema.js'

const caseTypes = new Set(['GUIDING_CASE', 'TYPICAL_CASE', 'ORDINARY_JUDGMENT'])

/** A negative screen only: a non-case hit is not thereby verified legal authority. */
export function isReferenceCase(candidate: CandidateLegalSource, verifiedTitle?: string): boolean {
  return caseTypes.has(candidate.record.sourceType)
    || /指导性案例|典型案例|参考案例|裁判文书|判决书|裁定书|纠纷案(?:$|[——：:])/.test(verifiedTitle ?? candidate.record.title)
}
