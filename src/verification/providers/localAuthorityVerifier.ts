import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AuthorityCorpus, authoritySnapshotText, splitAuthorityArticles, authorityArticleRelevance } from '../../authority/authorityCorpus.js'
import { authorityArticleProvenanceSchema, authorityHash } from '../../authority/authoritySchema.js'
import { parseOfficialAuthorityHtml, parserForOfficialHost } from '../../authority/officialAuthorityParser.js'
import { authoritySearchText, localAuthorityProviderId } from '../../retrieval/providers/localAuthorityProvider.js'
import type { LegalSourceVerifier } from '../legalSourceVerifier.js'
import { SourceVerificationError } from '../sourceVerificationError.js'
import { sourceVerificationRequestSchema, sourceVerificationResultSchema, unobservedVerificationChecks,
  verificationStatusFromChecks, type SourceVerificationRequest, type VerifiedLegalSource,
  type VerificationCheck, type VerificationEvidence } from '../sourceVerificationSchema.js'

const check = (ok: boolean, reason: string): VerificationCheck => ({ status: ok ? 'VERIFIED' : 'MISMATCH', reason })
const compact = (text: string) => text.replace(/\s/gu, '')

export class LocalAuthorityVerifier implements LegalSourceVerifier {
  constructor(private readonly corpus: AuthorityCorpus, private readonly now = () => new Date()) {}

  async verify(request: SourceVerificationRequest, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const input = sourceVerificationRequestSchema.parse(request)
    const { retrieval } = input
    if (retrieval.providerId !== localAuthorityProviderId) throw new SourceVerificationError('UNSUPPORTED_PROVIDER', 'Not a local Authority retrieval')
    const candidate = retrieval.sources.find(source => source.sourceId === input.candidateSourceId)!
    const { record } = candidate
    if (!record.authority || !input.query || !input.legalQuestion) {
      throw new SourceVerificationError('INVALID_INPUT', 'Local verification requires article identity and current query/question')
    }
    const verificationId = `verification-${randomUUID()}`
    const checkedAt = this.now().toISOString()
    const checks = unobservedVerificationChecks()
    checks.relevance = { status: 'UNKNOWN', reason: 'Current query/question not checked yet' }
    let evidence: VerificationEvidence = { requestedUrl: record.sourceUrl, redirects: [], localCorpus: record.authority }
    const finish = (verifiedSource?: VerifiedLegalSource) => sourceVerificationResultSchema.parse({
      verificationId, candidateSourceId: candidate.sourceId, retrievalId: retrieval.retrievalId,
      legalQuestionId: retrieval.legalQuestionId, legalSearchQueryId: retrieval.legalSearchQueryId,
      providerId: retrieval.providerId, providerSourceId: record.providerSourceId,
      status: verificationStatusFromChecks(checks), checkedAt, checks, evidence,
      ...(verifiedSource ? { verifiedSource } : {}),
    })
    const document = this.corpus.getDocument(record.authority.document.id)
    const article = this.corpus.getArticle(record.authority.article.id)
    checks.existence = check(!!document && !!article, 'Re-read document and article by their corpus IDs')
    if (!document || !article) return finish()
    const { bodyText: _body, ...metadata } = document
    const authority = authorityArticleProvenanceSchema.parse({ document: metadata, article })
    checks.sourceIdentity = check(article.documentId === document.id && record.providerSourceId === article.id
      && isDeepStrictEqual(authority, record.authority), 'Exact immutable candidate identity equals re-read document/article metadata')
    checks.title = check(record.title === document.title, 'Candidate title equals stored official document title')
    checks.url = check(record.sourceUrl === document.officialUrl, 'Candidate URL equals document official URL')
    checks.canonicalUrl = { status: 'NOT_APPLICABLE', reason: 'Local corpus does not assert an HTTP canonical declaration' }
    try {
      this.corpus.validateSource(document)
      checks.sourceOrigin = check(record.sourceOrigin === new URL(document.officialUrl).origin, 'Document matches configured official source/type allowlist')
    } catch {
      checks.sourceOrigin = check(false, 'Document is outside configured official source/type allowlist')
    }
    checks.sourceType = check(record.sourceType === document.documentType, 'Re-read allowed normative document type; cases are excluded')
    let raw: string
    try { raw = this.corpus.readSnapshot(document.id) }
    catch {
      checks.content = check(false, 'Official snapshot missing, unsafe or hash-mismatched')
      return finish()
    }
    const extracted = compact(authoritySnapshotText(raw, document.snapshotFormat))
    let completeArticle
    let rawArticleText: string | undefined
    let rawBodyMatches = true
    let validityScope = extracted
    try {
      completeArticle = splitAuthorityArticles(document.id, document.bodyText).find(item => item.articleNumber === article.articleNumber)
      if (document.snapshotFormat === 'HTML') {
        const parser = parserForOfficialHost(new URL(document.officialUrl).hostname)
        if (!parser) throw new Error('No inspected official HTML parser for this source; controlled text snapshot required')
        const parsed = parseOfficialAuthorityHtml(raw, parser, document.title)
        rawBodyMatches = parsed.content === document.bodyText
        rawArticleText = splitAuthorityArticles(document.id, parsed.content).find(item => item.articleNumber === article.articleNumber)?.text
        validityScope = compact(document.validityEvidence?.method === 'OFFICIAL_METADATA'
          ? parsed.metadataText : parsed.metadataText + '\n' + parsed.content)
      } else {
        const rawArticles = splitAuthorityArticles(document.id, raw)
        rawArticleText = rawArticles.find(item => item.articleNumber === article.articleNumber)?.text
        if (document.validityEvidence?.method === 'OFFICIAL_METADATA') validityScope = compact(raw.slice(0, rawArticles[0].start))
      }
    }
    catch {
      checks.content = check(false, 'Official raw snapshot or stored body cannot be independently parsed into complete legal articles')
      return finish()
    }
    const contentMatches = authorityHash(document.bodyText) === document.contentHash
      && authorityHash(article.text) === article.textHash && authorityHash(raw) === document.snapshotHash
      && document.bodyText.slice(article.start, article.end) === article.text
      && isDeepStrictEqual(article, completeArticle)
      && rawBodyMatches && rawArticleText === article.text
      && article.text.startsWith(article.articleNumber) && record.content === article.text
      && extracted.includes(compact(document.bodyText)) && extracted.includes(compact(document.title))
    checks.content = check(contentMatches, 'Snapshot, full body, exact article offset and three content hashes were independently checked')
    checks.completeness = check(contentMatches && article.end - article.start === article.text.length,
      'Article is an exact complete corpus slice, not a search snippet or arbitrary chunk')
    const validity = document.validityEvidence
    const reviewAgeMs = validity ? Date.parse(checkedAt) - Date.parse(validity.checkedAt) : Infinity
    const valid = document.validityStatus === 'EFFECTIVE' && !!validity && !!document.effectiveAt
      && document.effectiveAt <= checkedAt.slice(0, 10) && reviewAgeMs >= 0 && reviewAgeMs <= 30 * 24 * 60 * 60 * 1000
      && validity.officialUrl === document.officialUrl && validityScope.includes(compact(validity.excerpt))
    checks.legalStatus = check(valid, 'EFFECTIVE corpus status requires official snapshot evidence reviewed within 30 days; applicability remains separate')
    checks.publicationDate = document.promulgatedAt
      ? check(document.promulgatedAt <= checkedAt.slice(0, 10), 'Stored publication date is not in the future')
      : { status: 'UNKNOWN', reason: 'No official publication date recorded' }
    checks.snippet = { status: 'NOT_APPLICABLE', reason: 'Candidate is an exact complete article, not a search snippet' }
    const currentMatch = authorityArticleRelevance(article.text, authoritySearchText(input.query),
      input.legalQuestion.question, input.query.query)
    checks.relevance = check(currentMatch.relevanceSufficient && input.query.sourcePurpose !== 'REFERENCE',
      'Recomputed lexical or primary-task relevance against the actual current question/query; this is not a positive applicability review')
    evidence = { ...evidence, localCorpus: authority, finalUrl: document.officialUrl, fetchedAt: document.fetchedAt,
      responseBodyHash: document.snapshotHash, responseBytes: Buffer.byteLength(raw),
      extractedProviderSourceId: article.id, parserId: 'local-authority-article-v1', parsedTitle: document.title,
      contentHash: article.textHash, contentLength: article.text.length,
      relevanceMatch: currentMatch,
      ...(document.promulgatedAt ? { parsedPublicationDate: document.promulgatedAt } : {}) }
    if (verificationStatusFromChecks(checks) !== 'VERIFIED') return finish()
    return finish({ verificationScope: 'SOURCE_SNAPSHOT', contentTrust: 'UNTRUSTED',
      candidateSourceId: candidate.sourceId, verificationId, verifiedAt: checkedAt,
      providerSourceId: article.id, sourceUrl: document.officialUrl, sourceOrigin: new URL(document.officialUrl).origin,
      sourceType: document.documentType, legalStatus: 'EFFECTIVE', title: document.title,
      content: article.text, contentHash: article.textHash, locator: 'AUTHORITY_ARTICLE_TEXT', authority,
      ...(document.promulgatedAt ? { publicationDate: document.promulgatedAt } : {}) })
  }
}

export class AuthorityReferenceVerifier implements LegalSourceVerifier {
  constructor(private readonly authority: LegalSourceVerifier, private readonly reference: LegalSourceVerifier) {}
  verify(request: SourceVerificationRequest, signal?: AbortSignal) {
    return (request.retrieval.providerId === localAuthorityProviderId ? this.authority : this.reference).verify(request, signal)
  }
}
