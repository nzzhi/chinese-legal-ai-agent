import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Case } from '../case/caseSchema.js'
import { assertQuestionFacts } from '../case/caseSnapshot.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import type { LegalSearchQuery } from '../legalQuery/legalQuerySchema.js'
import type { CandidateLegalSource, LegalRetrievalResult } from '../retrieval/retrievalSchema.js'
import { isReferenceCase } from '../retrieval/sourceRole.js'
import { sourceVerificationResultSchema, type SourceVerificationResult } from '../verification/sourceVerificationSchema.js'
import { assessAuthorityQuestion, questionAssessmentPasses, rulePromotionDiagnosticSchema,
  type RulePromotionDiagnostic } from './authorityQuestionGate.js'
import {
  legalRuleApplicationSchema,
  legalRuleEvidenceSchema,
  type LegalRuleApplication,
  type LegalRuleEvidence,
} from './legalRuleSchema.js'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const effect = /《(?<legalName>[^》\n]{2,80})》[^。\n]{0,180}?(?:自|于)(?<year>\d{4})年(?<month>\d{1,2})月(?<day>\d{1,2})日起施行/gu

export interface LegalRuleExtractionInput {
  case: Case
  legalQuestions: LegalQuestion[]
  retrievedQueries: Array<{ query: LegalSearchQuery; retrieval: LegalRetrievalResult }>
  candidateVerifications: Array<{ query: LegalSearchQuery; retrieval: LegalRetrievalResult;
    candidate: CandidateLegalSource; result: SourceVerificationResult }>
}

/** Exact quotation plus deterministic question qualification; never human applicability review. */
export function extractLegalRuleEvidence(input: LegalRuleExtractionInput): {
  legalRules: LegalRuleEvidence[]
  ruleApplications: LegalRuleApplication[]
  rulePromotionDiagnostics: RulePromotionDiagnostic[]
} {
  assertQuestionFacts(input.case, input.legalQuestions)
  const questionById = new Map(input.legalQuestions.map(question => [question.id, question]))
  const memberships = new Map<string, Map<string, { legalSearchQueryId: string; retrievalId: string; query: LegalSearchQuery }>>()
  for (const { query, retrieval } of input.retrievedQueries) {
    if (query.id !== retrieval.legalSearchQueryId || query.legalQuestionId !== retrieval.legalQuestionId) {
      throw new Error('Retrieval provenance contradicts its query')
    }
    if (query.sourcePurpose === 'REFERENCE') continue
    for (const candidate of retrieval.sources) {
      const links = memberships.get(candidate.sourceId) ?? new Map<string, { legalSearchQueryId: string; retrievalId: string; query: LegalSearchQuery }>()
      if (!links.has(query.legalQuestionId)) {
        links.set(query.legalQuestionId, { legalSearchQueryId: query.id, retrievalId: retrieval.retrievalId, query })
      }
      memberships.set(candidate.sourceId, links)
    }
  }
  const legalRules: LegalRuleEvidence[] = []
  const applications: LegalRuleApplication[] = []
  const rulePromotionDiagnostics: RulePromotionDiagnostic[] = []
  const seen = new Set<string>()
  for (const { candidate, query, retrieval, result } of input.candidateVerifications) {
    sourceVerificationResultSchema.parse(result)
    if (candidate.sourceId !== result.candidateSourceId || query.id !== result.legalSearchQueryId
      || query.legalQuestionId !== result.legalQuestionId || result.retrievalId !== retrieval.retrievalId
      || result.providerId !== retrieval.providerId
      || !input.retrievedQueries.some(item => isDeepStrictEqual(item, { query, retrieval }))
      || !retrieval.sources.some(item => isDeepStrictEqual(item, candidate))) throw new Error('Verification provenance contradicts its candidate/query')
    const snapshot = result.verifiedSource
    if (!snapshot || result.status !== 'VERIFIED' || query.sourcePurpose === 'REFERENCE' || isReferenceCase(candidate, snapshot.title)) continue
    const effects = effectStatements(snapshot.content)
    const extracted: Array<{ legalName: string; article: string; ruleText: string; quote: string; start: number }> = []
    if (snapshot.authority) {
      const { document, article } = snapshot.authority
      if (document.validityStatus !== 'EFFECTIVE' || result.checks.relevance?.status !== 'VERIFIED'
        || article.text !== snapshot.content || article.textHash !== snapshot.contentHash) continue
      extracted.push({ legalName: document.title, article: article.articleNumber,
        ruleText: article.text.slice(article.articleNumber.length).trim(), quote: article.text, start: 0 })
    }
    for (const legalName of snapshot.authority ? [] : new Set(effects.map(statement => statement.legalName))) {
      const articlePattern = /(?:^|\n)(?<article>第[一二三四五六七八九十百千万零〇0-9]+条)(?<ruleText>[\s\S]*?)(?=\n第[一二三四五六七八九十百千万零〇0-9]+条|$)/gu
      for (const match of snapshot.content.matchAll(articlePattern)) {
        if (!match.groups || match.index === undefined || match.groups.ruleText.trim().length < 10) continue
        const leadingNewline = match[0].startsWith('\n') ? 1 : 0
        const quote = match[0].slice(leadingNewline)
        extracted.push({ legalName, article: match.groups.article, ruleText: match.groups.ruleText.trim(),
          quote, start: match.index + leadingNewline })
      }
    }
    for (const item of extracted) {
      const identity = JSON.stringify([snapshot.candidateSourceId, item.legalName, item.article, item.ruleText])
      if (seen.has(identity)) continue
      seen.add(identity)
      const ruleId = `rule-${sha256(identity)}`
      const qualified: Array<{ legalQuestionId: string; link: { legalSearchQueryId: string; retrievalId: string; query: LegalSearchQuery };
        assessment: ReturnType<typeof assessAuthorityQuestion> }> = []
      for (const [legalQuestionId, link] of memberships.get(snapshot.candidateSourceId) ?? []) {
        const question = questionById.get(legalQuestionId)
        if (!question) throw new Error('Rule promotion has no owning LegalQuestion')
        const assessment = assessAuthorityQuestion(item.quote, snapshot.authority?.article.heading ?? '', link.query, question)
        const validity = snapshot.authority?.document.validityStatus ?? 'UNKNOWN'
        const authenticity = snapshot.authority && result.checks.sourceType.status === 'VERIFIED' ? 'VERIFIED' : 'UNCERTAIN'
        const promoted = authenticity === 'VERIFIED' && validity === 'EFFECTIVE' && questionAssessmentPasses(assessment)
        rulePromotionDiagnostics.push(rulePromotionDiagnosticSchema.parse({
          legalQuestionId, legalSearchQueryId: link.legalSearchQueryId, retrievalId: link.retrievalId,
          candidateSourceId: snapshot.candidateSourceId, providerSourceId: snapshot.providerSourceId,
          verificationId: snapshot.verificationId, article: item.article, authenticity, validity,
          assessment, promoted, ...(promoted ? { ruleId } : {}),
          rejectReason: promoted ? '' : authenticity !== 'VERIFIED' ? '来源页面真实，不代表已核验为该规范正文'
            : validity !== 'EFFECTIVE' ? '来源核验不等于现行效力核验' : assessment.reason,
        }))
        if (promoted) qualified.push({ legalQuestionId, link, assessment })
      }
      if (!qualified.length) continue
      const first = qualified[0]
      const rule = legalRuleEvidenceSchema.parse({
        ruleId,
        legalName: item.legalName,
        article: item.article,
        ruleText: item.ruleText,
        locator: locator(item.start, item.quote),
        ruleTextVerification: { status: 'VERIFIED', method: 'EXACT_SOURCE_QUOTE' },
        legalStatus: snapshot.authority ? { status: 'VERIFIED', value: 'EFFECTIVE',
          checkedAt: snapshot.authority.document.validityEvidence!.checkedAt,
          authorityName: snapshot.authority.document.issuingAuthority, authorityUrl: snapshot.sourceUrl,
          versionAt: snapshot.authority.document.effectiveAt! }
          : { status: 'UNKNOWN', reason: 'Source snapshot does not establish continuing legal force' },
        version: snapshot.authority ? { status: 'VERIFIED', identifier: snapshot.authority.document.contentHash,
          checkedAt: snapshot.verifiedAt, authorityName: snapshot.authority.document.issuingAuthority,
          authorityUrl: snapshot.sourceUrl } : { status: 'UNKNOWN', reason: 'No independent official version check was performed' },
        sourceEffectStatements: effects.filter(statement => statement.legalName === item.legalName)
          .map(({ legalName: _legalName, ...statement }) => statement),
        qualification: { legalQuestionId: first.legalQuestionId,
          legalSearchQueryId: first.link.legalSearchQueryId, retrievalId: first.link.retrievalId, assessment: first.assessment },
        source: {
          candidateSourceId: snapshot.candidateSourceId,
          verificationId: snapshot.verificationId,
          retrievalId: result.retrievalId,
          legalSearchQueryId: result.legalSearchQueryId,
          providerId: result.providerId,
          providerSourceId: snapshot.providerSourceId,
          sourceUrl: snapshot.sourceUrl,
          sourceContentHash: snapshot.contentHash,
          ...(snapshot.authority ? { authority: snapshot.authority } : {}),
        },
      })
      legalRules.push(rule)
      for (const { legalQuestionId, link } of qualified) {
        const question = questionById.get(legalQuestionId)!
        applications.push(legalRuleApplicationSchema.parse({
          applicationId: `application-${sha256(JSON.stringify([ruleId, legalQuestionId]))}`,
          legalRuleId: ruleId,
          legalQuestionId,
          legalSearchQueryId: link.legalSearchQueryId,
          retrievalId: link.retrievalId,
          relatedFactIds: [...question.relatedFactIds],
          evidenceGaps: input.case.unknownFacts.map(item => item.question),
          status: 'UNKNOWN',
          reason: 'Retrieval provenance links the source to this question, but applicability has not been reviewed',
        }))
      }
    }
  }
  return { legalRules, ruleApplications: applications, rulePromotionDiagnostics }
}

function locator(start: number, quote: string) {
  return { kind: 'TEXT_OFFSET' as const, start, end: start + quote.length, quote, quoteHash: sha256(quote) }
}

function effectStatements(content: string) {
  effect.lastIndex = 0
  return [...content.matchAll(effect)].flatMap(match => {
    if (!match.groups || match.index === undefined) return []
    const month = match.groups.month.padStart(2, '0')
    const day = match.groups.day.padStart(2, '0')
    return [{ legalName: match.groups.legalName, text: match[0],
      effectiveDate: `${match.groups.year}-${month}-${day}`, locator: locator(match.index, match[0]),
      scope: 'SOURCE_TEXT_ONLY' as const }]
  })
}
