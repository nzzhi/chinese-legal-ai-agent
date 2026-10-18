import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { legalSearchQuerySchema, type LegalSearchQuery } from '../legalQuery/legalQuerySchema.js'
import { legalRuleApplicationSchema, legalRuleEvidenceSchema, type LegalRuleApplication,
  type LegalRuleEvidence } from '../legalRule/legalRuleSchema.js'
import { legalRetrievalResultSchema, type LegalRetrievalResult } from '../retrieval/retrievalSchema.js'
import { sourceVerificationResultSchema, type SourceVerificationResult } from '../verification/sourceVerificationSchema.js'
import { evidenceFragmentSchema, type EvidenceFragment } from './evidenceFragmentSchema.js'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export interface EvidenceFragmentExtractionInput {
  legalRules: LegalRuleEvidence[]
  ruleApplications: LegalRuleApplication[]
  retrievedQueries: Array<{ query: LegalSearchQuery; retrieval: LegalRetrievalResult }>
  candidateVerifications: Array<{ result: SourceVerificationResult }>
}

/** Fail closed: only exact text in a VERIFIED detail-page snapshot can become a fragment. */
export function extractEvidenceFragments(input: EvidenceFragmentExtractionInput): EvidenceFragment[] {
  const rules = input.legalRules.map(rule => legalRuleEvidenceSchema.parse(rule))
  const applications = input.ruleApplications.map(application => legalRuleApplicationSchema.parse(application))
  const ruleIds = new Set(rules.map(rule => rule.ruleId))
  if (ruleIds.size !== rules.length || applications.some(application => !ruleIds.has(application.legalRuleId))) {
    throw new Error('Rule/Application relationship is inconsistent')
  }

  const retrievals = input.retrievedQueries.map(({ query, retrieval }) => ({
    query: legalSearchQuerySchema.parse(query), retrieval: legalRetrievalResultSchema.parse(retrieval),
  }))
  const hasSourceRetrieval = (legalQuestionId: string, legalSearchQueryId: string, retrievalId: string,
    providerId: string, sourceId: string, providerSourceId: string) => retrievals.some(({ query, retrieval }) =>
      query.id === legalSearchQueryId && query.legalQuestionId === legalQuestionId
      && retrieval.retrievalId === retrievalId && retrieval.legalSearchQueryId === query.id
      && retrieval.legalQuestionId === query.legalQuestionId && retrieval.providerId === providerId
      && retrieval.sources.some(source => source.sourceId === sourceId
        && source.record.providerSourceId === providerSourceId))
  const results = input.candidateVerifications.map(({ result }) => sourceVerificationResultSchema.parse(result))
  return rules.map(rule => {
    const result = results.find(item => item.verificationId === rule.source.verificationId)
    const snapshot = result?.verifiedSource
    if (!result || result.status !== 'VERIFIED' || !snapshot
      || result.candidateSourceId !== rule.source.candidateSourceId
      || result.retrievalId !== rule.source.retrievalId
      || result.legalSearchQueryId !== rule.source.legalSearchQueryId
      || result.providerId !== rule.source.providerId
      || result.providerSourceId !== rule.source.providerSourceId
      || snapshot.providerSourceId !== rule.source.providerSourceId
      || snapshot.sourceUrl !== rule.source.sourceUrl
      || snapshot.contentHash !== rule.source.sourceContentHash
      || !isDeepStrictEqual(snapshot.authority, rule.source.authority)
      || !hasSourceRetrieval(result.legalQuestionId, result.legalSearchQueryId, result.retrievalId,
        result.providerId, result.candidateSourceId, result.providerSourceId)) {
      throw new Error(`Rule ${rule.ruleId} has no matching verified snapshot provenance`)
    }
    const { start, end, quote, quoteHash } = rule.locator
    if (end > snapshot.content.length || end - start !== quote.length
      || snapshot.content.slice(start, end) !== quote || sha256(quote) !== quoteHash) {
      throw new Error(`Rule ${rule.ruleId} locator does not match verified snapshot body`)
    }
    const applicationIds = applications.filter(application => application.legalRuleId === rule.ruleId)
      .map(application => {
        if (!hasSourceRetrieval(application.legalQuestionId, application.legalSearchQueryId,
          application.retrievalId, result.providerId, rule.source.candidateSourceId,
          result.providerSourceId)) {
          throw new Error(`Application ${application.applicationId} has no matching source retrieval`)
        }
        return application.applicationId
      }).sort()
    const fragmentId = `fragment-${sha256(JSON.stringify([
      rule.source.candidateSourceId, snapshot.contentHash, start, end, quoteHash,
    ]))}`
    return evidenceFragmentSchema.parse({
      fragmentId,
      ruleId: rule.ruleId,
      applicationIds,
      sourceId: snapshot.candidateSourceId,
      verificationScope: snapshot.verificationScope,
      contentTrust: snapshot.contentTrust,
      source: rule.source,
      locator: rule.locator,
    })
  })
}
