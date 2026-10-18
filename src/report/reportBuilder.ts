import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { caseSchema } from '../case/caseSchema.js'
import { assessCaseEvidence, caseEvidenceInputSchema, caseEvidenceUserLines } from '../caseEvidence/caseEvidence.js'
import { classificationResultSchema, disputeAnalysisResultSchema } from '../classification/classificationSchema.js'
import { legalQuestionSchema } from '../legalQuestion/legalQuestionSchema.js'
import { assessReliefCoverage } from '../legalQuestion/reliefCoverage.js'
import { legalSearchQuerySchema } from '../legalQuery/legalQuerySchema.js'
import { candidateLegalSourceSchema, legalRetrievalResultSchema } from '../retrieval/retrievalSchema.js'
import { isReferenceCase } from '../retrieval/sourceRole.js'
import { sourceVerificationResultSchema } from '../verification/sourceVerificationSchema.js'
import { legalRuleApplicationSchema, legalRuleEvidenceSchema } from '../legalRule/legalRuleSchema.js'
import { assessResearchProgress } from '../integration/researchProgress.js'
import { conditionalQuestionBlockSchema } from '../legalRule/conditionalAnalysis.js'
import { extractEvidenceFragments } from '../evidence/evidenceFragmentExtractor.js'
import { canPublishLegalConclusion } from './claimSupport.js'
import { ReportError } from './reportError.js'
import { disclaimer, type ClaimSupport, type IssueAssessmentStatus, type MaterialGap,
  type ReportBlock, type ReportClaim, type ReportModel } from './reportModel.js'

import { questionKey, sourceScopeNotice } from './reportPresentation.js'
import { authorityArticleRelevance } from '../authority/authorityCorpus.js'
import { authoritySearchText } from '../retrieval/providers/localAuthorityProvider.js'
import { assessAuthorityQuestion, questionAssessmentPasses } from '../legalRule/authorityQuestionGate.js'

// Validate only the consumed projection; diagnostics and future workflow fields stay in JSON.
const inputSchema = z.object({
  retrievalStatus: z.enum(['COMPLETE', 'DEGRADED', 'FAILED']).optional(),
  questionCoverage: z.array(z.object({ legalQuestionId: z.string(), status: z.enum(['PLANNED', 'MISSING']),
    legalSearchQueryId: z.string().optional() })).optional(),
  providerFailures: z.array(z.object({ query: legalSearchQuerySchema })).optional(),
  referenceCaseStatus: z.enum(['FOUND', 'NO_REFERENCE_CASE_FOUND', 'NOT_SEARCHED', 'BUDGET_EXHAUSTED', 'SEARCH_FAILED']).optional(),
  rawCase: z.string().min(1), case: caseSchema,
  caseEvidence: caseEvidenceInputSchema.optional(),
  classification: classificationResultSchema, disputeAnalysis: disputeAnalysisResultSchema,
  legalQuestions: z.array(legalQuestionSchema),
  reliefCoverage: z.array(z.object({
    reliefId: z.string(), action: z.enum(['RETURN_GOODS', 'RETURN_MONEY', 'PAY', 'COMPENSATE', 'TERMINATE', 'PERFORM', 'CEASE']),
    requestText: z.string(), relatedFactIds: z.array(z.string()), status: z.enum(['COVERED', 'MISSING']),
    legalQuestionIds: z.array(z.string()),
  })).optional(),
  retrievedQueries: z.array(z.object({ query: legalSearchQuerySchema, retrieval: legalRetrievalResultSchema })),
  unexecutedQueries: z.array(z.object({
    legalQuestionId: z.string(), legalSearchQueryId: z.string(),
    queryKind: z.enum(['PRIMARY', 'FALLBACK']),
    sourcePurpose: z.enum(['AUTHORITY', 'REFERENCE']).optional(),
    reason: z.enum(['QUERY_BUDGET_EXHAUSTED', 'PRIMARY_NOT_EXECUTED', 'REFERENCE_BUDGET_EXHAUSTED']),
  })).optional(),
  candidateVerifications: z.array(z.object({
    query: legalSearchQuerySchema, retrieval: legalRetrievalResultSchema,
    candidate: candidateLegalSourceSchema, result: sourceVerificationResultSchema,
  })),
  legalRules: z.array(legalRuleEvidenceSchema).optional(),
  ruleApplications: z.array(legalRuleApplicationSchema).optional(),
  conditionalAnalysis: z.object({ blocked: z.array(conditionalQuestionBlockSchema).max(24).optional() }).optional(),
})

const categories = {
  CONSUMER_DISPUTE: '消费者纠纷', CONTRACT_DISPUTE: '合同纠纷', SERVICE_DISPUTE: '服务纠纷',
  LOAN_DISPUTE: '借贷纠纷', EMPLOYMENT_DISPUTE: '劳动纠纷', PROPERTY_DISPUTE: '财产纠纷',
  TRAFFIC_DISPUTE: '交通纠纷', PROPERTY_DAMAGE: '财产损害', OTHER: '其他案件',
}
const certainty = {
  CONFIRMED: '系统标记已确认（来源为用户输入，未经独立证据核验）',
  USER_CLAIM: '用户陈述，尚未核实', DISPUTED: '存在争议', UNKNOWN: '尚不明确',
}
function block(kind: ReportBlock['kind'], text: string): ReportBlock {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(text)) {
    throw new Error('报告文本包含不支持的 XML/Unicode 字符')
  }
  return { kind, text }
}
const p = (text: string) => block('paragraph', text)
const h = (text: string) => block('heading', text)
const quote = (text: string) => block('quote', text)

const assessmentText: Record<IssueAssessmentStatus, string> = {
  CLEAR_BASIS: '有较明确依据',
  CONDITIONAL_BASIS: '有一定依据，但仍需核验关键条件',
  INSUFFICIENT_BASIS: '目前依据不足',
  NEEDS_FACTS: '无法判断，需要补充关键事实或证据',
  INSUFFICIENT_AUTHORITY: '未找到足够可靠的法律依据',
  NOT_RESEARCHED: '这一争议尚未完成法律研究',
}

function meaningfulWords(text: string): string[] {
  const stop = new Set(['是否', '如何', '什么', '哪些', '以及', '或者', '可以', '应当', '可能', '影响', '认定', '处理', '具体',
    '用户', '消费者', '商家', '对方', '事实', '材料', '服务', '合同', '退款', '预付款', '请求'])
  return [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)]
    .map(item => item.segment).filter(word => /^[\p{Script=Han}]{2,}$/u.test(word) && !stop.has(word))
}

function relatedQuestionIds(text: string, questions: z.infer<typeof legalQuestionSchema>[]): string[] {
  const words = [...new Set(meaningfulWords(text))]
  const scored = questions.map(question => ({ id: question.id,
    score: words.filter(word => question.question.includes(word)).length }))
  const best = Math.max(0, ...scored.map(item => item.score))
  return best === 0 ? [] : scored.filter(item => item.score === best).map(item => item.id)
}

function evidenceSuggestions(text: string): string[] {
  const suggestions: string[] = []
  if (/支付|付款|预付|金额|转账/u.test(text)) suggestions.push('支付凭证、银行或支付平台流水')
  if (/服务|次数|履行|使用|核销|预约/u.test(text)) suggestions.push('服务记录、预约记录、核销或消费记录')
  if (/承诺|约定|合同|退款条件|期限|内容|价格/u.test(text)) suggestions.push('合同及附件、宣传页、销售确认或聊天记录')
  if (/沟通|回应|拒绝|通知|确认/u.test(text)) suggestions.push('微信等聊天记录、短信、邮件或依法留存的录音')
  if (/身份|名称|主体/u.test(text)) suggestions.push('合同抬头、收款主体、发票或公开登记信息')
  if (/停止营业|经营状态|闭店/u.test(text)) suggestions.push('闭店通知、现场记录或公开经营状态信息')
  return suggestions.length ? [...new Set(suggestions)] : ['现有合同、聊天记录或其他能够直接证明该事实的材料']
}

function gapReason(questionIds: string[], questions: z.infer<typeof legalQuestionSchema>[]): string {
  const labels = questionIds.map(id => questions.find(question => question.id === id)?.question).filter(Boolean)
  return labels.length
    ? `该事实会直接影响对“${labels.slice(0, 2).join('”和“')}”的判断。`
    : '该事实可能影响用户请求能否得到支持，需要在采取后续行动前核实。'
}

function sameCandidateSnapshot(a: z.infer<typeof candidateLegalSourceSchema>, b: z.infer<typeof candidateLegalSourceSchema>) {
  // Retriever identity excludes query-specific ranking scores.
  const { retrievalScore: _a, ...left } = a.record
  const { retrievalScore: _b, ...right } = b.record
  return a.sourceId === b.sourceId && isDeepStrictEqual(left, right)
}

function validLocator(content: string, locator: z.infer<typeof legalRuleEvidenceSchema>['locator']): boolean {
  return content.slice(locator.start, locator.end) === locator.quote
    && createHash('sha256').update(locator.quote).digest('hex') === locator.quoteHash
}

export function buildReport(input: unknown, now = new Date()): ReportModel {
  try {
    const data = inputSchema.parse(input)
    block('quote', data.rawCase) // Validate even when structured facts replace this text in the brief.
    const requireLink = (ok: boolean) => { if (!ok) throw new Error('ResearchOutput 关联信息不一致') }
    requireLink(data.case.id === data.classification.caseId && data.case.id === data.disputeAnalysis.caseId)
    const facts = [...data.case.facts, ...data.case.disputedFacts.filter(f => !data.case.facts.some(a => a.id === f.id))]
    requireLink(new Set(data.case.facts.map(f => f.id)).size === data.case.facts.length)
    requireLink(new Set(data.case.disputedFacts.map(f => f.id)).size === data.case.disputedFacts.length)
    for (const f of data.case.disputedFacts) {
      const existing = data.case.facts.find(a => a.id === f.id)
      requireLink(!existing || JSON.stringify(existing) === JSON.stringify(f))
    }
    const factById = new Map(facts.map(f => [f.id, f]))
    const issues = data.disputeAnalysis.issues
    requireLink(new Set(issues.map(i => i.id)).size === issues.length)
    requireLink(new Set(data.legalQuestions.map(q => q.id)).size === data.legalQuestions.length)
    for (const q of data.legalQuestions) requireLink(issues.some(i => i.id === q.issueId))
    for (const item of [...issues, ...data.legalQuestions, ...data.disputeAnalysis.disputedFacts]) {
      requireLink(item.relatedFactIds.every(id => factById.has(id)))
    }
    const sources = new Map<string, { candidate: z.infer<typeof candidateLegalSourceSchema>; questions: Set<string>; retrievalIds: Set<string> }>()
    for (const { query, retrieval } of data.retrievedQueries) {
      requireLink(query.id === retrieval.legalSearchQueryId && query.legalQuestionId === retrieval.legalQuestionId
        && data.legalQuestions.some(q => q.id === query.legalQuestionId))
      for (const candidate of retrieval.sources) {
        const existing = sources.get(candidate.sourceId)
        if (existing) {
          requireLink(sameCandidateSnapshot(existing.candidate, candidate))
          existing.questions.add(query.legalQuestionId)
          existing.retrievalIds.add(retrieval.retrievalId)
        } else sources.set(candidate.sourceId, { candidate, questions: new Set([query.legalQuestionId]), retrievalIds: new Set([retrieval.retrievalId]) })
      }
    }
    const verifications = new Map<string, z.infer<typeof sourceVerificationResultSchema>>()
    const verificationEntries = new Map<string, z.infer<typeof inputSchema>['candidateVerifications'][number]>()
    const verificationKeys = new Set<string>()
    for (const entry of data.candidateVerifications) {
      const { candidate, result, retrieval, query } = entry
      const source = sources.get(candidate.sourceId)
      const verificationKey = JSON.stringify([query.legalQuestionId, candidate.sourceId])
      requireLink(!!source && !verificationKeys.has(verificationKey) && !verificationEntries.has(result.verificationId)
        && sameCandidateSnapshot(source.candidate, candidate)
        && source.retrievalIds.has(result.retrievalId)
        && result.candidateSourceId === candidate.sourceId && result.providerSourceId === candidate.record.providerSourceId
        && result.retrievalId === retrieval.retrievalId && result.providerId === retrieval.providerId
        && result.legalQuestionId === query.legalQuestionId && result.legalSearchQueryId === query.id
        && data.retrievedQueries.some(r => JSON.stringify(r) === JSON.stringify({ query, retrieval })))
      verificationKeys.add(verificationKey)
      if (!verifications.has(candidate.sourceId)) verifications.set(candidate.sourceId, result)
      verificationEntries.set(result.verificationId, entry)
    }
    const factContext = [data.rawCase, ...facts.map(f => f.content)].join('\n')
    const legalRules = data.legalRules ?? []
    const ruleApplications = data.ruleApplications ?? []
    const progress = assessResearchProgress({
      legalQuestions: data.legalQuestions, retrievalStatus: data.retrievalStatus,
      questionCoverage: data.questionCoverage,
      providerFailures: data.providerFailures,
      unexecutedQueries: data.unexecutedQueries,
      retrievedQueries: data.retrievedQueries,
      candidateVerifications: data.candidateVerifications,
      legalRules, ruleApplications, conditionalAnalysis: data.conditionalAnalysis,
    })
    requireLink(new Set(legalRules.map(rule => rule.ruleId)).size === legalRules.length)
    requireLink(new Set(ruleApplications.map(application => application.applicationId)).size === ruleApplications.length)
    const ruleById = new Map(legalRules.map(rule => [rule.ruleId, rule]))
    for (const rule of legalRules) {
      const entry = verificationEntries.get(rule.source.verificationId)
      const snapshot = entry?.result.verifiedSource
      requireLink(!!snapshot && entry!.candidate.sourceId === rule.source.candidateSourceId
        && entry!.query.sourcePurpose !== 'REFERENCE'
        && !isReferenceCase(entry!.candidate, snapshot.title)
        && (snapshot.authority
          ? isDeepStrictEqual(rule.source.authority, snapshot.authority)
            && isDeepStrictEqual(entry!.candidate.record.authority, snapshot.authority)
            && rule.legalName === snapshot.authority.document.title
            && rule.article === snapshot.authority.article.articleNumber
          : !rule.source.authority && rule.sourceEffectStatements.some(statement => statement.text.includes(`《${rule.legalName}》`)))
        && rule.locator.quote.startsWith(rule.article)
        && rule.source.verificationId === snapshot.verificationId
        && rule.source.retrievalId === entry!.result.retrievalId
        && rule.source.legalSearchQueryId === entry!.result.legalSearchQueryId
        && rule.source.providerId === entry!.result.providerId
        && rule.source.providerSourceId === snapshot.providerSourceId
        && rule.source.sourceUrl === snapshot.sourceUrl
        && rule.source.sourceContentHash === snapshot.contentHash
        && validLocator(snapshot.content, rule.locator)
        && rule.locator.quote.includes(rule.ruleText))
      for (const statement of rule.sourceEffectStatements) requireLink(validLocator(snapshot!.content, statement.locator))
      {
        const qualification = rule.qualification
        const question = data.legalQuestions.find(item => item.id === qualification?.legalQuestionId)
        const link = data.retrievedQueries.find(item => item.query.id === qualification?.legalSearchQueryId
          && item.retrieval.retrievalId === qualification?.retrievalId)
        requireLink(!!qualification && !!question && !!link
          && link.query.sourcePurpose !== 'REFERENCE' && link.query.legalQuestionId === question.id
          && link.retrieval.sources.some(source => source.sourceId === rule.source.candidateSourceId)
          && ruleApplications.some(application => application.legalRuleId === rule.ruleId
            && application.legalQuestionId === question.id && application.legalSearchQueryId === link.query.id
            && application.retrievalId === link.retrieval.retrievalId))
        const recomputed = assessAuthorityQuestion(rule.locator.quote, rule.source.authority?.article.heading ?? '', link!.query, question!)
        requireLink(questionAssessmentPasses(recomputed) && isDeepStrictEqual(qualification!.assessment, recomputed))
      }
    }
    for (const application of ruleApplications) {
      const rule = ruleById.get(application.legalRuleId)
      const question = data.legalQuestions.find(item => item.id === application.legalQuestionId)
      requireLink(!!rule && !!question && application.relatedFactIds.every(id =>
        factById.has(id) && question!.relatedFactIds.includes(id)))
      requireLink(data.retrievedQueries.some(({ query, retrieval }) =>
        query.id === application.legalSearchQueryId
        && query.sourcePurpose !== 'REFERENCE'
        && query.legalQuestionId === application.legalQuestionId
        && retrieval.retrievalId === application.retrievalId
        && retrieval.legalSearchQueryId === query.id
        && retrieval.legalQuestionId === query.legalQuestionId
        && retrieval.sources.some(source => source.sourceId === rule!.source.candidateSourceId)
        && (!rule!.source.authority || authorityArticleRelevance(rule!.source.authority.article.text,
          authoritySearchText(query), question!.question, query.query).relevanceSufficient)
        && questionAssessmentPasses(assessAuthorityQuestion(rule!.locator.quote,
          rule!.source.authority?.article.heading ?? '', query, question!))))
      // Reviewed metadata is still only a candidate for a report conclusion.
      // The ClaimSupport gate below decides whether it may be published.
    }
    const caseEvidenceAssessment = assessCaseEvidence({ case: data.case, legalQuestions: data.legalQuestions,
      ruleApplications, disputeAnalysis: data.disputeAnalysis, evidence: data.caseEvidence })
    const supportedFactIds = new Set(caseEvidenceAssessment.factSupports.filter(f => f.status === 'SUPPORTED').map(f => f.factId))
    const fragments = extractEvidenceFragments({ legalRules, ruleApplications,
      retrievedQueries: data.retrievedQueries, candidateVerifications: data.candidateVerifications })
    const fragmentByRule = new Map(fragments.map(fragment => [fragment.ruleId, fragment]))
    const ruleEvidence: ReportModel['ruleEvidence'] = fragments.map(fragment => {
      const rule = ruleById.get(fragment.ruleId)!
      const snapshot = verificationEntries.get(rule.source.verificationId)!.result.verifiedSource!
      return { fragment, rule, citation: {
        ruleEvidenceId: fragment.fragmentId, verifiedSourceId: snapshot.verificationId,
        candidateSourceId: snapshot.candidateSourceId, sourceUrl: snapshot.sourceUrl,
        contentHash: snapshot.contentHash, characterStart: fragment.locator.start,
        characterEnd: fragment.locator.end, exactQuote: fragment.locator.quote,
      } }
    })
    const claimRecords: ReportClaim[] = []
    const claimSupports: ClaimSupport[] = []
    const unresolvedIssues: ReportModel['unresolvedIssues'] = []
    for (const application of ruleApplications) {
      const rule = ruleById.get(application.legalRuleId)!
      const fragment = fragmentByRule.get(rule.ruleId)
      const question = data.legalQuestions.find(item => item.id === application.legalQuestionId)!
      const snapshot = verificationEntries.get(rule.source.verificationId)!.result.verifiedSource!
      const topicMatches = !sourceScopeNotice(`${snapshot.title} ${rule.legalName}`, factContext).startsWith('主题不匹配：')
      const validityStatus: ClaimSupport['validityStatus'] = rule.legalStatus.status === 'UNKNOWN'
        ? 'UNKNOWN' : rule.legalStatus.value === 'EFFECTIVE' ? 'VERIFIED' : 'FAILED'
      const versionStatus: ClaimSupport['versionStatus'] = rule.version.status
      const applicabilityStatus: ClaimSupport['applicabilityStatus'] = application.status === 'UNKNOWN'
        ? 'UNKNOWN' : application.status === 'VERIFIED_NOT_APPLICABLE' ? 'REJECTED' : 'HUMAN_REVIEWED'
      const candidate: ClaimSupport = {
        id: `claim-support-${application.applicationId}`,
        legalQuestionId: question.id, factIds: [...application.relatedFactIds],
        ruleEvidenceIds: fragment ? [fragment.fragmentId] : [], claimType: 'LEGAL_CONCLUSION',
        supportStatus: 'SUPPORTED', validityStatus, versionStatus, applicabilityStatus,
        ...(application.assessment ? { reasoning: application.assessment.analysis } : {}),
      }
      const publish = !!application.assessment && application.status === 'VERIFIED_APPLICABLE'
        && application.evidenceGaps.length === 0
        && canPublishLegalConclusion(candidate, {
          factIds: new Set(question.relatedFactIds.filter(id => factById.has(id))),
          supportedFactIds,
          legalQuestionIds: new Set(data.legalQuestions.map(item => item.id)),
          ruleEvidenceIds: new Set(ruleEvidence.map(item => item.fragment.fragmentId)), topicMatches,
        })
      candidate.supportStatus = publish ? 'SUPPORTED'
        : !topicMatches || applicabilityStatus === 'REJECTED' || validityStatus === 'FAILED'
          || !fragment || !application.relatedFactIds.length
          ? 'UNSUPPORTED' : 'PARTIALLY_SUPPORTED'
      claimSupports.push(candidate)
      if (publish) {
        claimRecords.push({ claim: application.assessment!.conclusion, support: candidate,
          citations: [ruleEvidence.find(item => item.fragment.fragmentId === fragment!.fragmentId)!.citation] })
      } else {
        const reason = !topicMatches ? '规则主题与案件事实不匹配'
          : !application.relatedFactIds.length ? '缺少具体 factId'
          : !fragment ? '缺少可定位的 ruleEvidenceId'
          : validityStatus !== 'VERIFIED' || versionStatus !== 'VERIFIED' ? '规则现行效力或版本尚未核验'
          : applicabilityStatus === 'REJECTED' ? '人工审查认为该规则不适用于本案'
          : applicabilityStatus !== 'HUMAN_REVIEWED' ? '案件适用性尚未人工确认'
          : application.relatedFactIds.some(id => !supportedFactIds.has(id)) ? '所引用的案件事实尚缺充分材料支持'
          : application.evidenceGaps.length ? '案件事实或证据仍有缺口' : '当前证据不足以支持确定性结论'
        unresolvedIssues.push({ legalQuestionId: question.id, factIds: [...application.relatedFactIds],
          ruleEvidenceIds: fragment ? [fragment.fragmentId] : [], reason })
      }
    }
    const missingAuthorityIssues = data.legalQuestions.filter(question =>
      !ruleApplications.some(application => application.legalQuestionId === question.id))
      .map(question => ({ legalQuestionId: question.id, factIds: [...question.relatedFactIds],
        ruleEvidenceIds: [], reason: progress.authorityCoverage.find(item => item.legalQuestionId === question.id)?.status === 'NOT_RESEARCHED'
          ? '法律依据查询或来源验证尚未完成，当前无法判断依据是否不足'
          : '尚未取得可追溯的法律规范依据，依据不足，需进一步研究' }))
    unresolvedIssues.push(...missingAuthorityIssues)
    const notExecuted = data.unexecutedQueries ?? []
    for (const item of notExecuted) {
      requireLink(data.legalQuestions.some(q => q.id === item.legalQuestionId)
        && !data.retrievedQueries.some(r => r.query.id === item.legalSearchQueryId))
    }
    const refs = [...sources.values()].map((source) => {
      const verification = verifications.get(source.candidate.sourceId)
      const snapshot = verification?.verifiedSource
      const title = snapshot?.title ?? source.candidate.record.title
      return { title, url: snapshot?.sourceUrl ?? source.candidate.record.sourceUrl,
        notice: sourceScopeNotice(title, factContext), verified: !!snapshot,
        referenceCase: isReferenceCase(source.candidate, snapshot?.title) }
    })
    const reliefs = data.reliefCoverage ?? assessReliefCoverage(data.rawCase, data.case, data.legalQuestions)
    for (const relief of reliefs) requireLink(relief.relatedFactIds.every(id => factById.has(id))
      && relief.legalQuestionIds.every(id => data.legalQuestions.some(question => question.id === id)))
    const userGoals = reliefs.map(relief => ({ id: relief.reliefId, description: relief.requestText,
      relatedFactIds: [...relief.relatedFactIds], legalQuestionIds: [...relief.legalQuestionIds] }))
    const relevantFactIds = new Set([...issues, ...data.legalQuestions].flatMap(item => item.relatedFactIds)
      .concat(userGoals.flatMap(goal => goal.relatedFactIds)))
    const relevantFacts = facts.filter(fact => relevantFactIds.size === 0 || relevantFactIds.has(fact.id))
    const disputedFacts: ReportModel['caseOverview']['disputedFacts'] = [
      ...data.disputeAnalysis.disputedFacts.filter(item => item.opposingPosition).map(item => ({ ...item })),
      ...data.case.disputedFacts.filter(fact => !data.disputeAnalysis.disputedFacts.some(item => item.relatedFactIds.includes(fact.id)))
        .map(fact => ({ id: fact.id, topic: fact.content, relatedFactIds: [fact.id] }))]
    const caseOverview: ReportModel['caseOverview'] = {
      userGoals,
      keyFacts: relevantFacts.filter(fact => fact.certainty === 'CONFIRMED')
        .map(({ id, content, certainty }) => ({ id, content, certainty })),
      disputedFacts,
      unconfirmedFacts: relevantFacts.filter(fact => fact.certainty === 'USER_CLAIM' || fact.certainty === 'UNKNOWN')
        .map(({ id, content, certainty }) => ({ id, content, certainty })),
      coreIssues: data.legalQuestions.map(question => ({ legalQuestionId: question.id,
        issueId: question.issueId, question: question.question })),
    }

    const materialGapMap = new Map<string, MaterialGap>()
    for (const [index, unknown] of data.case.unknownFacts.entries()) {
      const questionIds = relatedQuestionIds(unknown.question, data.legalQuestions)
      if (unknown.importance !== 'HIGH') continue
      materialGapMap.set(questionKey(unknown.question), {
        id: `material-gap-unknown-${index + 1}`, kind: 'UNKNOWN_FACT', description: unknown.question,
        importance: unknown.importance, whyItMatters: gapReason(questionIds, data.legalQuestions),
        suggestedEvidence: [`请先说明事实：${unknown.question}`], legalQuestionIds: questionIds, relatedFactIds: [],
      })
    }
    for (const disputed of disputedFacts) {
      const questionIds = data.legalQuestions.filter(question =>
        disputed.relatedFactIds.some(id => question.relatedFactIds.includes(id))).map(question => question.id)
      if (!questionIds.length) continue
      const description = `${disputed.topic}${disputed.opposingPosition
        ? `：用户说法为“${disputed.userPosition ?? '未明确'}”，对方说法为“${disputed.opposingPosition}”` : '：现有材料尚未形成双方一致事实'}`
      materialGapMap.set(questionKey(description), {
        id: `material-gap-disputed-${disputed.id}`, kind: 'DISPUTED_FACT', description, importance: 'HIGH',
        whyItMatters: gapReason(questionIds, data.legalQuestions), suggestedEvidence: evidenceSuggestions(description),
        legalQuestionIds: questionIds, relatedFactIds: [...disputed.relatedFactIds],
      })
    }
    for (const application of ruleApplications) {
      for (const [index, description] of application.evidenceGaps.entries()) {
        const key = questionKey(description)
        if (data.case.unknownFacts.some(item => questionKey(item.question) === key) || materialGapMap.has(key)) continue
        materialGapMap.set(key, {
          id: `material-gap-application-${application.applicationId}-${index + 1}`,
          kind: 'APPLICATION_EVIDENCE_GAP', description, importance: 'HIGH',
          whyItMatters: gapReason([application.legalQuestionId], data.legalQuestions),
          suggestedEvidence: evidenceSuggestions(description), legalQuestionIds: [application.legalQuestionId],
          relatedFactIds: [...application.relatedFactIds],
        })
      }
    }
    for (const gap of caseEvidenceAssessment.evidenceGaps) materialGapMap.set(gap.id, {
      id: gap.id, kind: 'CASE_EVIDENCE_GAP', description: `${factById.get(gap.factId)!.content}：${gap.reason}`,
      importance: gap.importance, whyItMatters: gap.whyItMatters,
      suggestedEvidence: gap.suggestedEvidence, legalQuestionIds: gap.legalQuestionIds, relatedFactIds: [gap.factId],
    })
    const materialGaps = [...materialGapMap.values()]
    const issueAssessments: ReportModel['issueAssessments'] = data.legalQuestions.map(question => {
      const applications = ruleApplications.filter(application => application.legalQuestionId === question.id)
      const published = claimRecords.filter(claim => claim.support.legalQuestionId === question.id)
      const coverage = progress.authorityCoverage.find(item => item.legalQuestionId === question.id)?.status
      const questionGaps = materialGaps.filter(gap => gap.legalQuestionIds.includes(question.id))
      let status: IssueAssessmentStatus
      if (coverage === 'NOT_RESEARCHED' || coverage === undefined) status = 'NOT_RESEARCHED'
      else if (!applications.length || coverage === 'INSUFFICIENT_AUTHORITY') status = 'INSUFFICIENT_AUTHORITY'
      else if (published.length) status = 'CLEAR_BASIS'
      else if (questionGaps.length) status = 'NEEDS_FACTS'
      else if (applications.every(application => application.status === 'VERIFIED_NOT_APPLICABLE')) status = 'INSUFFICIENT_BASIS'
      else status = 'CONDITIONAL_BASIS'
      const analysis = applications.flatMap(application => {
        const rule = ruleById.get(application.legalRuleId)!
        if (application.status === 'VERIFIED_APPLICABLE' && application.assessment) {
          return published.length ? [application.assessment.analysis, application.assessment.conclusion]
            : [application.assessment.analysis]
        }
        if (application.status === 'VERIFIED_NOT_APPLICABLE') return [`《${rule.legalName}》${rule.article}经审查不适用于当前事实。`]
        return [`已找到《${rule.legalName}》${rule.article}的规则文字，但尚未完成效力、版本或本案适用性核验。`]
      })
      if (!analysis.length) analysis.push(status === 'NOT_RESEARCHED'
        ? '这一争议的法律依据查询或来源验证尚未完成。'
        : '当前没有取得能够支持该争议判断的可追溯法律规范依据。')
      const uncertainty = questionGaps.map(gap => gap.description)
      for (const application of applications) {
        const rule = ruleById.get(application.legalRuleId)!
        if (rule.legalStatus.status !== 'VERIFIED') uncertainty.push('相关规则的现行效力尚未独立核验。')
        if (rule.version.status !== 'VERIFIED') uncertainty.push('相关规则的适用版本尚未独立核验。')
        if (application.status === 'UNKNOWN') uncertainty.push('规则对本案的具体适用性尚未完成审查。')
      }
      if (status === 'INSUFFICIENT_AUTHORITY') uncertainty.push('当前没有足够可靠法律依据，不能据此支持或否定用户主张。')
      if (status === 'NOT_RESEARCHED') uncertainty.push('这一争议目前尚未完成法律研究。')
      return {
        legalQuestionId: question.id, issueId: question.issueId, question: question.question,
        status, statusText: assessmentText[status],
        supportingFactIds: [...new Set(applications.flatMap(application => application.relatedFactIds)
          .concat(question.relatedFactIds))].filter(id => factById.has(id)),
        ruleEvidenceIds: [...new Set(applications.flatMap(application => {
          const fragment = fragmentByRule.get(application.legalRuleId)
          return fragment ? [fragment.fragmentId] : []
        }))],
        applicationIds: applications.map(application => application.applicationId), analysis,
        uncertainty: [...new Set(uncertainty)],
      }
    })
    const legalAuthorities: ReportModel['legalAuthorities'] = ruleEvidence.map(item => ({
      ruleId: item.rule.ruleId, legalName: item.rule.legalName, article: item.rule.article,
      ruleText: item.rule.ruleText,
      legalQuestionIds: ruleApplications.filter(application => application.legalRuleId === item.rule.ruleId)
        .map(application => application.legalQuestionId),
      legalStatus: item.rule.legalStatus, versionStatus: item.rule.version, citation: item.citation,
    }))
    const referenceMaterials: ReportModel['referenceMaterials'] = refs.filter(ref => ref.referenceCase)
      .map(({ referenceCase: _referenceCase, ...ref }) => ref)
    const allQuestionIds = data.legalQuestions.map(question => question.id)
    const recommendedActions: ReportModel['recommendedActions'] = []
    const addAction = (action: string, whyNow: string, materials: string[], legalQuestionIds: string[]) =>
      recommendedActions.push({ order: recommendedActions.length + 1, action, whyNow,
        materials: [...new Set(materials)], legalQuestionIds: [...new Set(legalQuestionIds)] })
    if (materialGaps.length) addAction('先整理并核实关键事实和证据',
      '这些缺口会直接影响退款范围、合同履行或其他核心争议，先补齐可避免后续主张建立在未确认事实上。',
      materialGaps.flatMap(gap => gap.suggestedEvidence), materialGaps.flatMap(gap => gap.legalQuestionIds))
    else addAction('保存并整理现有基础材料', '后续协商、投诉或诉讼都需要能够还原交易和履行过程的原始材料。',
      ['合同及附件、支付凭证、履行记录和沟通记录'], allQuestionIds)
    if (materialGaps.some(gap => gap.kind === 'DISPUTED_FACT')) addAction('向对方书面确认仍有争议的事实',
      '书面确认可以固定双方说法和时间线，但不得诱导、篡改或制造证据。',
      ['已有聊天记录、合同、履行记录以及拟确认的事实清单'],
      materialGaps.filter(gap => gap.kind === 'DISPUTED_FACT').flatMap(gap => gap.legalQuestionIds))
    if (userGoals.length) addAction(`向对方提出明确、可留痕的请求：${userGoals.map(goal => goal.description).join('；')}`,
      '在关键材料初步整理后明确请求和回复期限，便于判断对方是否拒绝、拖延或愿意协商。',
      ['能够支持请求的合同、付款、履行和沟通材料'], userGoals.flatMap(goal => goal.legalQuestionIds))
    if (data.classification.classification.primary === 'CONSUMER_DISPUTE') addAction('协商无结果时，考虑消费者权益保护或有关行政投诉渠道',
      '小额消费纠纷通常可先使用成本较低的外部协调渠道；是否受理取决于具体事项和当地规则。',
      ['案件时间线、明确请求、对方回复及关键证据副本'], allQuestionIds)
    const researchIncomplete = issueAssessments.some(item =>
      item.status === 'INSUFFICIENT_AUTHORITY' || item.status === 'NOT_RESEARCHED')
    addAction(researchIncomplete ? '补充法律依据后，再决定是否进入诉讼' : '协商或投诉未解决时，再评估并准备诉讼',
      researchIncomplete ? '至少一个核心争议尚缺可靠法律依据或未完成研究，现在直接判断诉讼结果并不稳妥。'
        : '现有分析只能辅助决策；进入诉讼前仍应结合完整证据、请求金额和成本复核。',
      ['完整证据目录、请求金额计算、主体信息和已完成的法律依据'], allQuestionIds)

    const internalDiagnostics: ReportModel['internalDiagnostics'] = {
      retrievalStatus: data.retrievalStatus, ...progress,
      questionCoverage: data.questionCoverage ?? [], referenceStatus: data.referenceCaseStatus,
      unexecutedQueries: notExecuted,
    }
    const researchNotice = progress.researchStatus === 'INSUFFICIENT_AUTHORITY'
      ? '至少一个核心争议目前没有足够可靠的法律依据；这不等于用户主张一定不成立。'
      : progress.researchStatus === 'INDETERMINATE'
        ? '至少一个核心争议尚未完成法律研究，当前不能作出明确判断。'
        : progress.researchStatus === 'NO_LEGAL_QUESTIONS'
          ? '当前材料尚未形成可研究的核心法律争议。'
          : '已取得可追溯的规则材料；每项判断仍以对应事实、效力、版本和适用性状态为限。'
    const executionNotice = data.retrievalStatus === 'FAILED'
      ? '本次资料检索未能完成，相关争议只能保留为待研究状态。'
      : data.retrievalStatus === 'DEGRADED'
        ? '本次资料检索只完成了一部分，未完成内容不能视为零结果。'
        : data.unexecutedQueries === undefined
          ? '原始记录未提供未执行查询清单，因此无法确认所有查询均已执行。'
          : undefined
    const section = (title: string, blocks: ReportBlock[]) => ({ title, blocks })
    const overviewBlocks: ReportBlock[] = [p(researchNotice), ...(executionNotice ? [p(executionNotice)] : []), h('用户目标'),
      ...(userGoals.length ? userGoals.map(goal => p(goal.description)) : [p('现有结构化结果未识别出明确请求，请先确认希望对方具体做什么。')]),
      h('已确认的核心事实'),
      ...(caseOverview.keyFacts.length ? caseOverview.keyFacts.map(fact => p(fact.content))
        : [p('现有材料中没有可单列为已确认的核心事实；用户陈述仍需证据支持。')]),
      ...(caseOverview.unconfirmedFacts.length ? [h('尚未确认的核心事实'),
        ...caseOverview.unconfirmedFacts.map(fact => p(`${fact.content}（${certainty[fact.certainty]}）`))] : []),
      ...(caseOverview.disputedFacts.length ? [h('双方争议事实'), ...caseOverview.disputedFacts.map(fact =>
        p(`${fact.topic}${fact.userPosition ? `：用户说法为“${fact.userPosition}”` : ''}${fact.opposingPosition ? `；对方说法为“${fact.opposingPosition}”` : '；对方说法尚未取得'}`))] : []),
      h('核心争议'), ...(caseOverview.coreIssues.length
        ? caseOverview.coreIssues.map(issue => p(issue.question)) : [p('当前尚未形成核心法律争议。')])]
    const assessmentBlocks = issueAssessments.length ? issueAssessments.flatMap((assessment, index) => {
      const factTexts = assessment.supportingFactIds.map(id => factById.get(id)!)
      const authorities = assessment.ruleEvidenceIds.map(id => ruleEvidence.find(item => item.fragment.fragmentId === id)?.rule)
        .filter((rule): rule is NonNullable<typeof rule> => !!rule)
      return [h(`${index + 1}. ${assessment.question}`), p(`当前判断：${assessment.statusText}`),
        p(`关键事实：${factTexts.length ? factTexts.map(fact => `${fact.content}（${certainty[fact.certainty]}）`).join('；') : '暂无可直接对应的结构化事实。'}`),
        p(`法律规则：${authorities.length ? authorities.map(rule => `《${rule.legalName}》${rule.article}`).join('；') : '当前未取得足够可靠且可追溯的法律规则。'}`),
        ...assessment.analysis.map(item => p(`分析：${item}`)),
        p(`不确定性：${assessment.uncertainty.length ? assessment.uncertainty.join('；') : '现有结构化结果未记录额外不确定性。'}`)]
    }) : [p('当前尚未形成可评估的核心争议。')]
    const legacyGaps = materialGaps.filter(g => g.kind !== 'CASE_EVIDENCE_GAP')
    const gapBlocks = legacyGaps.length ? [
      p('以下仅列会影响核心争议的缺口；材料建议是寻找和保全既有证据，不表示材料已经存在。'),
      ...legacyGaps.flatMap((gap, index) => [h(`${index + 1}. ${gap.description}`),
        p(`为什么重要：${gap.whyItMatters}`), p(`${gap.kind === 'UNKNOWN_FACT' ? '先澄清事实' : '如果仍能取得，可寻找'}：${gap.suggestedEvidence.join('；')}`)]),
    ] : []
    const actionBlocks = recommendedActions.flatMap(action => [h(`${action.order}. ${action.action}`),
      p(`为什么现在做：${action.whyNow}`), p(`需要的材料：${action.materials.join('；')}`),
      p(`影响的争议：${action.legalQuestionIds.length ? action.legalQuestionIds.map(id =>
        data.legalQuestions.find(question => question.id === id)?.question).filter(Boolean).join('；') : '案件整体事实整理和后续决策。'}`)])
    const authorityBlocks: ReportBlock[] = legalAuthorities.length ? legalAuthorities.flatMap((authority, index) => [
      h(`${index + 1}. 《${authority.legalName}》${authority.article}`), quote(authority.ruleText),
      p(`核验边界：规则文字来自已核对的来源正文；现行效力为${authority.legalStatus.status === 'VERIFIED' ? authority.legalStatus.value : '尚未独立核验'}，版本为${authority.versionStatus.status === 'VERIFIED' ? authority.versionStatus.identifier : '尚未独立核验'}。`),
      { ...p('查看法律来源'), href: authority.citation.sourceUrl },
    ]) : [p('当前没有取得足够可靠且可追溯的法律规范依据。')]
    const referenceStatusNotice = data.referenceCaseStatus === 'NO_REFERENCE_CASE_FOUND'
      ? '本次未检索到足够匹配的公开参考案例；这不影响法律规范依据的单独评估。'
      : data.referenceCaseStatus === 'BUDGET_EXHAUSTED'
        ? '可选参考案例检索预算已用尽；这不改变法律规范依据的判断。'
        : data.referenceCaseStatus === 'SEARCH_FAILED'
          ? '可选参考案例检索未完成；这不改变法律规范依据的判断。' : undefined
    if (referenceStatusNotice) authorityBlocks.push(p(referenceStatusNotice))
    if (referenceMaterials.length) authorityBlocks.push(h('辅助参考材料（不能替代法律依据）'),
      ...referenceMaterials.flatMap(reference => [p(`${reference.title}：${reference.verified ? '已核对来源页面正文；' : '尚未获得完整核验的来源正文；'}仅用于了解类似裁判思路。`),
        ...(reference.url ? [{ ...p('查看参考材料'), href: reference.url }] : [])]))
    authorityBlocks.push(p('完整来源快照、核验状态和 provenance 保留在研究 JSON；内部执行代码不作为用户结论展示。'), p(disclaimer))
    return {
      title: '案件分析', subtitle: `${categories[data.classification.classification.primary]}案件分析`, generatedAt: now.toISOString(),
      ...progress, facts, caseEvidenceAssessment, legalQuestions: data.legalQuestions, ruleEvidence, claimSupports,
      supportedClaims: claimRecords, unresolvedIssues, caseOverview, issueAssessments, materialGaps,
      recommendedActions, legalAuthorities, referenceMaterials, internalDiagnostics,
      sections: [section('案件概况', overviewBlocks), section('争议判断', assessmentBlocks),
        section('证据与事实缺口', [...caseEvidenceUserLines(caseEvidenceAssessment, data.case).map(p), ...gapBlocks]), section('下一步行动', actionBlocks),
        section('法律依据与参考材料', authorityBlocks)],
    }
  } catch (cause) {
    throw new ReportError('MODEL', '无法从 ResearchOutput 构建报告：数据校验或关联检查失败', { cause })
  }
}
