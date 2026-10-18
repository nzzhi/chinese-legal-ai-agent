import { z } from 'zod'
import { legalQuestionSchema, type LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import { legalSearchQuerySchema, type LegalSearchQuery } from '../legalQuery/legalQuerySchema.js'
import { legalDomainAnchors, legalRelationshipAnchors, disputeAnchors } from '../legalQuery/fallbackGrounding.js'
import { authorityConceptMatch } from '../authority/authorityConcepts.js'

const nonBlank = z.string().trim().min(1)
const decision = z.enum(['PASS', 'FAIL', 'UNCERTAIN'])
export const authorityQuestionAssessmentSchema = z.strictObject({
  applicability: decision, relevance: decision, reason: nonBlank,
  evidence: z.array(z.strictObject({ concept: nonBlank, quote: nonBlank, scope: z.enum(['ARTICLE', 'HEADING']) })),
})
export type AuthorityQuestionAssessment = z.infer<typeof authorityQuestionAssessmentSchema>
export const ruleQualificationSchema = z.strictObject({
  legalQuestionId: nonBlank, legalSearchQueryId: nonBlank, retrievalId: nonBlank,
  assessment: authorityQuestionAssessmentSchema,
})
export const rulePromotionDiagnosticSchema = ruleQualificationSchema.safeExtend({
  candidateSourceId: nonBlank, providerSourceId: nonBlank, verificationId: nonBlank,
  article: nonBlank,
  authenticity: z.enum(['VERIFIED', 'FAIL', 'UNCERTAIN']),
  validity: z.enum(['EFFECTIVE', 'REPEALED', 'NOT_YET_EFFECTIVE', 'UNKNOWN']),
  promoted: z.boolean(), ruleId: nonBlank.optional(), rejectReason: z.string(),
}).superRefine((value, context) => {
  const eligible = value.authenticity === 'VERIFIED' && value.validity === 'EFFECTIVE'
    && value.assessment.applicability === 'PASS' && value.assessment.relevance === 'PASS'
  if (value.promoted !== eligible || value.promoted !== !!value.ruleId
    || (!value.promoted && !value.rejectReason.trim())) context.addIssue({ code: 'custom', message: 'Promotion contradicts qualification' })
})
export type RulePromotionDiagnostic = z.infer<typeof rulePromotionDiagnosticSchema>

const normalize = (text: string) => text.normalize('NFKC').replace(/\s/gu, '')
const grammatical = /是否|能否|如何|应当|需要|的/gu
const compactConcept = (text: string) => normalize(text).replace(grammatical, '')

/** Positive, question-owned evidence, not a blacklist of unwanted articles.
 * PASS means a plausible research basis, NOT adjudicated applicability or human review.
 * ponytail: closed shared concepts plus exact source grounding, not a complete legal ontology.
 */
export function assessAuthorityQuestion(
  articleText: string, heading: string, queryInput: LegalSearchQuery, questionInput: LegalQuestion,
): AuthorityQuestionAssessment {
  const query = legalSearchQuerySchema.parse(queryInput)
  const question = legalQuestionSchema.parse(questionInput)
  z.string().min(1).max(4_000_000).parse(articleText)
  z.string().max(8000).parse(heading)
  z.string().max(8000).parse(question.question)
  z.string().max(4000).parse(query.query)
  const conceptsInput = z.array(z.string().min(1).max(4000)).max(64)
  conceptsInput.parse(query.keywords); conceptsInput.parse(query.legalConcepts)
  if (query.legalQuestionId !== question.id) throw new Error('Question qualification query belongs to another question')
  const text = normalize(articleText), scope = normalize(heading)
  const questionText = compactConcept(question.question)
  const inquiry = question.questionType === 'PROCEDURE'
    ? [...question.question.matchAll(/如何|能否|可否|哪些|什么|怎样/gu)].at(-1) : undefined
  // Procedural background may mention money/interest without asking about its payment.
  const answerTarget = compactConcept(inquiry ? question.question.slice(inquiry.index! + inquiry[0].length) : question.question)
  const relationships = legalRelationshipAnchors(question.question)
  const domains = relationships.length ? relationships : legalDomainAnchors(question.question)
  const concepts = [...new Set(query.legalConcepts.map(compactConcept))]
  const evidence: AuthorityQuestionAssessment['evidence'] = []
  const record = (concept: string, inHeading = false) => {
    const content = inHeading ? scope : text
    if (concept.length < 2 || !content.includes(concept)
      || !(inHeading ? heading : articleText).includes(concept)) return false
    evidence.push({ concept, quote: concept, scope: inHeading ? 'HEADING' : 'ARTICLE' })
    return true
  }
  const domainMatch = domains.some(concept => record(concept) || record(concept, true))
  // A compound query concept can name a chapter topic plus a question-owned operation.
  // Keep the operation even when a trailing inquiry (e.g. 什么影响) follows it.
  // Both parts need exact source evidence; neither aliases nor model-only topics suffice.
  const compoundFocus = query.keywords.map(compactConcept).filter(focus => focus.length >= 3
    && questionText.includes(focus) && concepts.some(concept => {
      if (!concept.endsWith(focus)) return false
      const topic = concept.slice(0, -focus.length)
      return topic.length >= 2 && !domains.some(domain => topic.includes(domain))
        && concepts.some(other => other !== concept && other.includes(topic) && !other.includes(focus))
        && scope.includes(topic) && text.includes(topic) && text.includes(focus)
        && heading.includes(topic) && articleText.includes(topic) && articleText.includes(focus)
        && record(topic, true) && record(topic)
    }))
  // A general-rule chapter may bridge specific relationships, e.g. a limitation chapter.
  // A generic word in an arbitrary article or the name of the entire statute cannot bridge them.
  const generalScope = concepts.filter(concept => questionText.includes(concept)
    && !domains.some(domain => concept.includes(domain)))
    .some(concept => record(concept, true) || (!domains.length && record(concept)))
  const applicability: AuthorityQuestionAssessment['applicability'] = domainMatch || generalScope || compoundFocus.length ? 'PASS'
    : domains.length ? 'FAIL' : 'UNCERTAIN'

  const focusConcepts = concepts.flatMap(concept => {
    if (legalDomainAnchors(concept).includes(concept) || domains.some(domain => concept === domain + '合同')) return []
    const focus = domains.reduce((remaining, domain) => remaining.replaceAll(domain, ''), concept)
    return answerTarget.includes(focus) && focus.length >= 2 ? [focus] : []
  })
  const explicitActions = question.questionType === 'PROCEDURE' ? []
    : disputeAnchors(question.question, question.questionType).filter(action => query.query.includes(action))
  // The existing question type is also owned input: formation need not repeat 成立 in every paraphrase.
  const typedFocus = question.questionType === 'CONTRACT_FORMATION' ? ['成立'] : []
  const focusKeywords = query.keywords.map(compactConcept).filter(concept =>
    concept.length >= 3 && answerTarget.includes(concept) && !domains.some(domain => concept.includes(domain)))
  const focus = [...new Set([...focusConcepts, ...explicitActions, ...focusKeywords, ...typedFocus, ...compoundFocus])]
  const focusMatch = focus.some(concept => record(concept))
  const relevance: AuthorityQuestionAssessment['relevance'] = applicability === 'FAIL' ? 'FAIL'
    : focusMatch ? 'PASS' : 'UNCERTAIN'
  const reason = applicability === 'FAIL' ? '条文及其自身章节未建立当前问题的法律关系关联'
    : applicability === 'UNCERTAIN' ? '缺少可确定的法律关系或通用规范章节关联，保留候选待审查'
      : !focusMatch ? '法律关系可能覆盖，但完整条文未建立当前争议行为或请求对象的回答关联'
        : '完整条文/自身章节与问题法律关系关联，正文存在当前查询的争议概念或行为证据'
  const original = authorityQuestionAssessmentSchema.parse({ applicability, relevance, reason, evidence })
  // Preserve grounded substantive rules and persisted qualifications; a general norm is an
  // additional question-owned route, not a replacement for the existing relationship/action gate.
  if (questionAssessmentPasses(original) || !['PROCEDURE', 'OTHER'].includes(question.questionType)) return original
  // IDENTIFIABLE_DEFENDANT is a procedural subject-identification intent, not liability.
  // Own-question expressions only; a query/model concept or the word 被告 alone cannot create it.
  const identifiableDefendant = question.questionType === 'PROCEDURE'
    && /明确.{0,6}被告|确定.{0,6}被告|起诉谁|起诉对象|被告主体.{0,8}(确定|明确)|谁.{0,6}作为被告|确定.{0,6}诉讼对象/.test(questionText)
  if (identifiableDefendant) {
    const procedureSection = scope.includes('起诉') && /受理|程序/.test(scope)
    const core = articleText.includes('有明确的被告')
    const particulars = articleText.includes('起诉状') && articleText.includes('被告的姓名') && articleText.includes('住所')
    if (procedureSection && (core || particulars)) return authorityQuestionAssessmentSchema.parse({ applicability: 'PASS', relevance: 'PASS',
      reason: '明确被告程序意图与自身起诉章节及正文主体识别要求关联；不判断该主体的实体责任或现有身份材料是否充分',
      evidence: [{ concept: '起诉', quote: '起诉', scope: 'HEADING' },
        { concept: '被告主体识别', quote: core ? '有明确的被告' : '被告的姓名', scope: 'ARTICLE' }] })
  }
  // Local intent projection only: retrieval and its shared vocabulary remain unchanged.
  const intentQuestion = question.question.replace(/提起民事诉讼/gu, '起诉')
    .replace(/时间(?:方面的)?限制|多久还能起诉|超过(?:多久|多长时间)|起诉期限/gu, '诉讼时效')
  const match = authorityConceptMatch(articleText, '', intentQuestion)
  if (!match.intent || !match.sufficient) return original
  const role = match.intent.role
  const ownSection = role === 'PROCEDURE' ? scope.includes('起诉') && /受理|程序/.test(scope)
    : role === 'EVIDENCE' ? /证据|举证/.test(scope) : scope.includes('诉讼时效')
  // General period inquiries need broad institutional coverage. A special subject/right rule
  // or a recalculation operation cannot qualify merely because it shares the chapter name.
  const institutionFit = role !== 'LIMITATION' || !intentQuestion.includes('重新计算')
    && (match.intent.groups.length === 2 || match.coverage >= 0.8)
  if (!ownSection || !institutionFit) return original
  const subject = match.intent.groups[0].terms.find(term => scope.includes(term) && heading.includes(term))
  const semanticEvidence: AuthorityQuestionAssessment['evidence'] = match.matchedConcepts.filter(concept => articleText.includes(concept))
    .map(concept => ({ concept, quote: concept, scope: 'ARTICLE' }))
  if (semanticEvidence.length < 2) return original
  if (subject) semanticEvidence.push({ concept: subject, quote: subject, scope: 'HEADING' })
  return authorityQuestionAssessmentSchema.parse({ applicability: 'PASS', relevance: 'PASS',
    reason: `${role === 'PROCEDURE' ? '程序' : role === 'EVIDENCE' ? '证据' : '一般制度'}问题与条文自身章节及正文联合概念关联；案件关系仅作为背景，具体适用仍待审查`,
    evidence: semanticEvidence })
}

export const questionAssessmentPasses = (assessment: AuthorityQuestionAssessment) =>
  assessment.applicability === 'PASS' && assessment.relevance === 'PASS'
