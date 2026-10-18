import type { LegalQuestion } from '../../legalQuestion/legalQuestionSchema.js'
import type { LegalSearchQuery, PlannedLegalSearchQuery } from '../../legalQuery/legalQuerySchema.js'
import { AuthorityCorpus, formulateAuthorityFts } from '../../authority/authorityCorpus.js'
import { authorityArticleProvenanceSchema } from '../../authority/authoritySchema.js'
import type { LegalRetrievalProvider, LegalRetriever } from '../legalRetriever.js'
import { RetrievalError } from '../retrievalError.js'

export const localAuthorityProviderId = 'local-authority-corpus-v1'
export const authoritySearchText = (query: LegalSearchQuery) =>
  [query.query, ...query.keywords, ...query.legalConcepts].join(' ')

export class LocalAuthorityProvider implements LegalRetrievalProvider {
  readonly id = localAuthorityProviderId
  private questions = new Map<string, string>()

  constructor(private readonly corpus: AuthorityCorpus) {}

  formulateQueryPlans(plans: PlannedLegalSearchQuery[], questions?: readonly LegalQuestion[]): PlannedLegalSearchQuery[] {
    this.questions = new Map((questions ?? []).map(question => [question.id, question.question]))
    const project = (query: LegalSearchQuery) => ({ ...query,
      providerQuery: formulateAuthorityFts(authoritySearchText(query), this.questions.get(query.legalQuestionId)).providerQuery })
    return plans.map(plan => ({ ...project(plan), fallbackQueries: plan.fallbackQueries.map(project),
      ...(plan.fallbackRejections ? { fallbackRejections: plan.fallbackRejections } : {}) }))
  }

  requestIdentity(query: LegalSearchQuery): string {
    return JSON.stringify([this.id, query.query, authoritySearchText(query), this.questions.get(query.legalQuestionId) ?? null])
  }

  async search(query: LegalSearchQuery, signal: AbortSignal) {
    signal.throwIfAborted()
    if (query.sourcePurpose === 'REFERENCE') throw new RetrievalError('INVALID_INPUT', 'Local Authority is not a case reference provider')
    // ponytail: three relevant articles per query; raise only when measured missing coverage warrants it.
    const hits = this.corpus.search({ query: authoritySearchText(query), taskQuery: query.query, legalQuestion: this.questions.get(query.legalQuestionId),
      topK: 3, validityStatuses: ['EFFECTIVE'] }).filter(hit => hit.match.relevanceSufficient)
    return { complete: true, queryDiagnostics: {
      providerQuery: formulateAuthorityFts(authoritySearchText(query), this.questions.get(query.legalQuestionId)).providerQuery,
      matches: hits.map(hit => ({ providerSourceId: hit.article.id, match: hit.match })),
    }, sources: hits.map(({ document, article, score }) => {
      const { bodyText: _body, ...metadata } = document
      return { providerSourceId: article.id, sourceType: document.documentType, title: document.title,
        content: article.text, sourceOrigin: new URL(document.officialUrl).origin, sourceUrl: document.officialUrl,
        locator: article.articleNumber, retrievalScore: score,
        authority: authorityArticleProvenanceSchema.parse({ document: metadata, article }) }
    }) }
  }
}

/** Route by declared purpose; each result keeps its actual provider and source identities. */
export class AuthorityReferenceRetriever implements LegalRetriever {
  readonly providerId = 'authority-reference-router-v1'
  constructor(private readonly authority: LegalRetriever, private readonly reference: LegalRetriever) {}
  private route(query: LegalSearchQuery) { return query.sourcePurpose === 'REFERENCE' ? this.reference : this.authority }
  providerIdForQuery(query: LegalSearchQuery) { return this.route(query).providerId ?? 'unknown-provider' }
  formulateQueryPlans(plans: PlannedLegalSearchQuery[], questions?: readonly LegalQuestion[]): PlannedLegalSearchQuery[] {
    const authority = this.authority.formulateQueryPlans?.(plans.filter(plan => plan.sourcePurpose !== 'REFERENCE'), questions)
      ?? plans.filter(plan => plan.sourcePurpose !== 'REFERENCE')
    const reference = this.reference.formulateQueryPlans?.(plans.filter(plan => plan.sourcePurpose === 'REFERENCE'), questions)
      ?? plans.filter(plan => plan.sourcePurpose === 'REFERENCE')
    const projected = new Map([...authority, ...reference].map(plan => [plan.id, plan]))
    return plans.map(plan => projected.get(plan.id)!)
  }
  requestIdentity(query: LegalSearchQuery) { return this.route(query).requestIdentity?.(query) }
  retrieve(query: LegalSearchQuery) { return this.route(query).retrieve(query) }
}
