import { z } from 'zod'
import { buildReport } from './reportBuilder.js'
import { disclaimer, type ReportModel, type ReportBlock } from './reportModel.js'
import type { CaseFactSupportStatus } from '../caseEvidence/caseEvidence.js'
import { evidenceStage, type WorkspaceGap } from '../caseEvidence/caseEvidence.js'
import { legalRuleApplicationSchema } from '../legalRule/legalRuleSchema.js'
import { escapeHtml as html, markdownText as md, safeSourceLink as link } from './reportMarkup.js'

export const factSupportText: Record<CaseFactSupportStatus, string> = {
  SUPPORTED: '已有材料支持', PARTIAL: '已有部分材料，但仍不完整',
  UNSUPPORTED: '目前只有你的陈述，尚缺直接材料支持', UNKNOWN: '尚未确认，所提材料仍需核对',
}
const researchText: Record<ReportModel['researchStatus'], string> = {
  COMPLETE: '已找到相关法律材料，具体判断仍需结合证据、规则效力及适用条件确认。',
  INSUFFICIENT_AUTHORITY: '部分法律问题目前缺少足够可靠的法律依据，不能据此支持或否定你的主张。',
  INDETERMINATE: '部分法律问题尚未完成研究，当前不能作出完整判断。',
  NO_LEGAL_QUESTIONS: '现有信息尚未形成明确的法律问题，请先澄清案件经过和请求。',
}
const evidenceNames = { CONTRACT: '合同材料', PAYMENT_RECORD: '付款记录', CHAT_RECORD: '聊天记录',
  AUDIO: '录音', VIDEO: '视频', IMAGE: '图片', RECEIPT: '收据', INVOICE: '发票', NOTICE: '通知',
  PLATFORM_RECORD: '平台记录', OTHER: '其他材料' }
type Section = ReportModel['sections'][number]
export type PrintableReport = Pick<ReportModel, 'title' | 'subtitle' | 'generatedAt' | 'sections'>

/** IDs and citations are retained here for auditing; renderers only consume sections/appendix. */
export interface UserCaseReportModel extends PrintableReport {
  summary: { caseType: string; goals: string[]; status: string; caseSummary: string }
  keyFindings: Array<{ text: string; questionIds: string[]; applicationIds: string[]; factIds: string[]; gapIds: string[] }>
  keyFacts: Array<{ factId: string; content: string; support: ReportModel['caseEvidenceAssessment']['factSupports'][number];
    evidenceStatus: string; basis: string[] }>
  legalIssues: Array<{ questionId: string; question: string; conclusion: string; application: string;
    supportingFactIds: string[]; applicationIds: string[]; claimSupportIds: string[]; ruleEvidenceIds: string[];
    coreRuleEvidenceIds: string[]; whyRelated: string; evidenceStatus: string; unresolvedPoints: string[]; gapIds: string[]; inMainReport: boolean }>
  evidenceOverview: Array<{ evidenceId: string; title: string; possibleSupport: string[]; limitation: string; factIds: string[] }>
  evidenceGaps: Array<{ id: string; importance: 'HIGH' | 'MEDIUM'; description: string; why: string; purpose: string;
    suggestions: string[]; alternatives: string[]; factIds: string[]; questionIds: string[]; applicationIds: string[] }>
  nextActions: Array<{ text: string; gapIds: string[]; questionIds: string[] }>
  legalSources: ReportModel['ruleEvidence']
  limitations: string[]
  appendix: Section[]
  workspaceGaps?: WorkspaceGap[]
}

const unique = <T>(values: T[]) => [...new Set(values)]
const phrase = (text: string) => text.replace(/[。；\s]+$/u, '')
const userFact = (text: string) => phrase(text.replace(/^用户(?:主张|陈述)(?:其)?/u, '你表示')
  .replace(/^用户表示/u, '你表示').replace(/^用户询问/u, '你想了解'))
const p = (text: string): ReportBlock => ({ kind: 'paragraph', text })
const h = (text: string): ReportBlock => ({ kind: 'heading', text })
const section = (title: string, blocks: ReportBlock[]): Section => ({ title, blocks })
const short = (text: string, limit = 110) => Array.from(text).length <= limit ? text : `${Array.from(text).slice(0, limit).join('')}…`
const ruleName = (item: ReportModel['ruleEvidence'][number]) => `《${item.rule.legalName}》${item.rule.article}`
function sourceStatus(item: ReportModel['ruleEvidence'][number]): string {
  const status = item.rule.legalStatus
  return `原研究核对结果：${status.status !== 'VERIFIED' ? '现行效力尚待核对' : {
    EFFECTIVE: '已核对为现行有效', NOT_YET_EFFECTIVE: '尚未生效', REPEALED: '已废止',
  }[status.value]}；${item.rule.version.status === 'VERIFIED' ? '版本已核对' : '适用版本尚待核对'}；来源正文已核对。`
}

/** Unknown input always passes the existing schema, graph and publication gates first. No research runs here. */
export function buildUserCaseReport(input: unknown, now?: Date): UserCaseReportModel {
  const internal = buildReport(input, now)
  const rawCase = z.object({ rawCase: z.string() }).parse(input).rawCase
  const assessment = internal.caseEvidenceAssessment
  const applications = z.object({ ruleApplications: z.array(legalRuleApplicationSchema).optional() }).parse(input).ruleApplications ?? []
  const facts = new Map(internal.facts.map(f => [f.id, f]))
  const items = new Map(assessment.items.map(e => [e.id, e]))
  const isRequest = (id: string) => facts.get(id)?.category === 'OTHER' && /希望|想|询问|要求/.test(facts.get(id)!.content)
  const relevantIds = new Set([
    ...internal.legalQuestions.flatMap(q => q.relatedFactIds),
    ...internal.claimSupports.flatMap(c => c.factIds),
    ...assessment.applicationEvidence.flatMap(a => a.facts.map(f => f.factId)),
    ...internal.materialGaps.flatMap(g => g.relatedFactIds),
  ])
  const keyFacts: UserCaseReportModel['keyFacts'] = internal.facts.filter(f => relevantIds.has(f.id)).map(f => {
    const support = assessment.factSupports.find(s => s.factId === f.id)!
    return { factId: f.id, content: f.content, support, evidenceStatus: factSupportText[support.status],
      basis: support.evidenceIds.map(id => { const item = items.get(id)!
        return `${item.title ?? evidenceNames[item.type]}${assessment.items.some(e => e.file) ? `（${evidenceStage(item, assessment.items)}）` : item.source === 'USER_REPORTED' ? '（你提到持有，尚未提交原文）' : ''}` }) }
  })
  const evidenceGaps: UserCaseReportModel['evidenceGaps'] = internal.materialGaps.map(g => {
    const detail = assessment.evidenceGaps.find(e => e.id === g.id)
    const fact = detail ? facts.get(detail.factId)! : undefined
    const request = fact ? isRequest(fact.id) : false
    const contractWithoutService = fact?.category === 'CONTRACT' && !/消费|服务|套餐|订单|商家|销售/.test(rawCase)
    return { id: g.id, importance: g.importance, description: detail ? facts.get(detail.factId)!.content : g.description,
      why: g.legalQuestionIds.length ? `影响“${short(internal.legalQuestions.find(q => q.id === g.legalQuestionIds[0])!.question, 65)}”的判断。` : g.whyItMatters,
      purpose: request ? '确认你的请求和希望研究的问题范围，无需对方证明你提出过这一诉求。' : detail?.purpose ?? `澄清：${g.description}`,
      suggestions: request ? ['先确认请求和问题范围'] : g.kind === 'UNKNOWN_FACT'
        ? ['先说明该事实，再核对相应原始记录及完整上下文'] : [...g.suggestedEvidence],
      alternatives: request ? [] : contractWithoutService ? ['与这项约定对应的同期沟通或对方确认'] : detail?.alternatives ?? [],
      factIds: [...g.relatedFactIds], questionIds: [...g.legalQuestionIds], applicationIds: detail?.applicationIds ?? [] }
  }).sort((a, b) => Number(b.importance === 'HIGH') - Number(a.importance === 'HIGH'))
  // Keep lower-priority unknown facts and application gaps omitted by the old print projection.
  for (const [index, question] of assessment.factQuestions.entries()) {
    if (evidenceGaps.some(g => g.description === question.question)) continue
    const related = applications.filter(a => a.evidenceGaps.includes(question.question))
    if (question.importance !== 'HIGH' && related.length === 0) continue
    evidenceGaps.push({ id: `user-fact-question-${index + 1}`, importance: question.importance === 'HIGH' ? 'HIGH' : 'MEDIUM',
      description: question.question, why: '这部分事实尚未澄清，会限制相应问题的进一步判断。',
      purpose: `澄清：${question.question}`, suggestions: ['可以先说明事实，并核对相关原始记录和完整上下文'], alternatives: [],
      factIds: [], questionIds: unique(related.map(a => a.legalQuestionId)), applicationIds: related.map(a => a.applicationId) })
  }
  for (const a of applications) for (const [index, gap] of a.evidenceGaps.entries()) {
    const existing = evidenceGaps.find(g => g.description === gap)
    if (existing) {
      existing.questionIds = unique([...existing.questionIds, a.legalQuestionId])
      existing.applicationIds = unique([...existing.applicationIds, a.applicationId])
    } else evidenceGaps.push({ id: `user-application-gap-${a.applicationId}-${index + 1}`, importance: 'HIGH',
      description: gap, why: '现有案件分析明确记录了这一缺口，补充前不能确认相应判断。', purpose: `澄清：${gap}`,
      suggestions: ['与该事项对应的原始记录和完整上下文'], alternatives: [], factIds: [],
      questionIds: [a.legalQuestionId], applicationIds: [a.applicationId] })
  }
  evidenceGaps.sort((a, b) => Number(b.importance === 'HIGH') - Number(a.importance === 'HIGH'))
  const sortedQuestions = [...internal.legalQuestions].sort((a, b) =>
    Number(b.importance === 'HIGH') - Number(a.importance === 'HIGH'))
  // ponytail: four issue families are expanded in print; every question remains a separate appendix card.
  const selected: string[] = [], families = new Set<string>(), expandedRules = new Set<string>()
  const select = (id: string) => {
    const q = sortedQuestions.find(q => q.id === id)!
    if (selected.length >= 4 || families.has(q.issueId)) return
    selected.push(id); families.add(q.issueId)
    internal.issueAssessments.find(i => i.legalQuestionId === id)!.ruleEvidenceIds.forEach(id => expandedRules.add(id))
  }
  if (sortedQuestions.length) select(sortedQuestions[0].id)
  const blocked = sortedQuestions.find(q => !internal.issueAssessments.find(i => i.legalQuestionId === q.id)!.ruleEvidenceIds.length)
  if (blocked) select(blocked.id)
  for (const q of sortedQuestions) if (internal.issueAssessments.find(i => i.legalQuestionId === q.id)!.ruleEvidenceIds.some(id => !expandedRules.has(id))) select(q.id)
  for (const q of sortedQuestions) select(q.id)
  const legalIssues: UserCaseReportModel['legalIssues'] = sortedQuestions.map(q => {
    const issue = internal.issueAssessments.find(i => i.legalQuestionId === q.id)!
    const issueFacts = keyFacts.filter(f => issue.supportingFactIds.includes(f.factId))
    const published = internal.supportedClaims.filter(c => c.support.legalQuestionId === q.id)
    const gaps = evidenceGaps.filter(g => g.questionIds.includes(q.id)
      || g.factIds.some(id => issue.supportingFactIds.includes(id)))
    const supported = issueFacts.length > 0 && issueFacts.every(f => f.support.status === 'SUPPORTED')
    const conclusion = published.length && supported
      ? published.map(c => c.claim).join('；')
      : issue.status === 'NOT_RESEARCHED' ? '这个问题尚未完成法律研究，暂不能判断。'
      : issue.status === 'INSUFFICIENT_AUTHORITY' ? '尚缺足够可靠的法律依据，不能据此确认你的请求是否成立。'
      : issue.status === 'INSUFFICIENT_BASIS' ? '现有规则经审查不能支持对当前事实作出肯定判断。'
      : !supported ? '如果相关事实能够得到进一步证明，才能继续评估请求是否成立；目前不能作出确定结论。'
      : '已有材料支持相关事实，但规则效力、版本或本案适用条件仍需核对。'
    const coreRuleEvidenceIds = issue.ruleEvidenceIds.slice(0, 1)
    return { questionId: q.id, question: q.question, conclusion,
      application: published.length && supported ? conclusion
        : `${issueFacts.length ? `本案涉及：${issueFacts.map(f => f.content).join('；')}` : '尚缺可直接对应的具体事实。'}${!supported ? '上述事实仍未全部获得完整材料支持。' : '相关事实已有材料支持。'}${issue.ruleEvidenceIds.length ? '已找到对应规则文字，具体适用仍须确认。' : '目前尚缺可用于这个问题的可靠规则。'}`,
      supportingFactIds: [...issue.supportingFactIds], applicationIds: [...issue.applicationIds],
      claimSupportIds: internal.claimSupports.filter(c => c.legalQuestionId === q.id).map(c => c.id),
      ruleEvidenceIds: [...issue.ruleEvidenceIds], coreRuleEvidenceIds,
      whyRelated: coreRuleEvidenceIds.length ? `需要结合${issueFacts.length ? `“${userFact(issueFacts[0].content)}”等事实` : '本案事实'}，核对这条规定中的条件是否满足。` : '',
      evidenceStatus: unique(issueFacts.map(f => f.evidenceStatus)).join('；') || '尚缺对应事实材料',
      unresolvedPoints: unique([...gaps.map(g => g.description),
        ...internal.unresolvedIssues.filter(i => i.legalQuestionId === q.id).map(i => i.reason)]),
      gapIds: gaps.map(g => g.id), inMainReport: selected.includes(q.id) }
  })
  const mainIssues = selected.map(id => legalIssues.find(i => i.questionId === id)!)
  const highGaps = evidenceGaps.filter(g => g.importance === 'HIGH')
  const coreQuestions = internal.legalQuestions.filter(q => q.importance === 'HIGH')
  const core = legalIssues.filter(i => coreQuestions.some(q => q.id === i.questionId))
  const ready = core.length > 0 && highGaps.length === 0 && core.every(i => i.applicationIds.length > 0
    && i.ruleEvidenceIds.length > 0 && internal.issueAssessments.find(a => a.legalQuestionId === i.questionId)?.status === 'CLEAR_BASIS'
    && i.supportingFactIds.length > 0 && i.supportingFactIds.every(id => keyFacts.find(f => f.factId === id)?.support.status === 'SUPPORTED'))
  const nextActions: UserCaseReportModel['nextActions'] = []
  if (evidenceGaps.length) nextActions.push({ text: `先补事实和证据：按下列缺口核对现有记录${highGaps.length ? '，优先处理标为“优先补充”的项目' : ''}。`,
    gapIds: evidenceGaps.map(g => g.id), questionIds: unique(evidenceGaps.flatMap(g => g.questionIds)) })
  nextActions.push({ text: '保存已持有材料的原始文件和完整上下文，另存备份；整理时间线，不改写原始记录。', gapIds: [], questionIds: [] })
  const communication = internal.legalQuestions.filter(q => ['CONTRACT_PERFORMANCE', 'REFUND', 'CONTRACT_TERMINATION'].includes(q.questionType))
  if (communication.length) nextActions.push({ text: '如尚未形成完整书面记录，可以考虑通过可留痕方式明确提出你的请求，并保存对方回复。',
    gapIds: [], questionIds: communication.map(q => q.id) })
  if (internal.researchStatus !== 'COMPLETE') nextActions.push({ text: '部分法律问题仍需补充可靠依据；证据整理和法律研究应同时推进。',
    gapIds: [], questionIds: legalIssues.filter(i => !i.ruleEvidenceIds.length).map(i => i.questionId) })
  nextActions.push({ text: ready ? '当前材料已可以进入诉讼材料准备阶段；提交前仍需复核请求、主体信息及材料完整性。'
    : '目前更适合先补充材料和未完成的法律依据，再决定是否进入诉讼准备或生成起诉状。',
    gapIds: highGaps.map(g => g.id), questionIds: core.map(i => i.questionId) })
  const evidenceOverview = assessment.items.map(item => ({ evidenceId: item.id,
    title: item.title ?? evidenceNames[item.type], factIds: [...item.relatedFactIds],
    possibleSupport: (item.file ? assessment.links.filter(l => l.evidenceId === item.id && l.status !== 'CANCELLED').map(l => l.factId)
      : item.relatedFactIds).map(id => facts.get(id)!.content),
    limitation: assessment.items.some(e => e.file) ? `${evidenceStage(item, assessment.items)}；内容登记不代表真实性鉴定或法院采信。` : item.source === 'USER_REPORTED' ? '你提到持有这份材料，尚未提交原文，不能据此确认相关事实。'
      : assessment.links.some(l => l.evidenceId === item.id) ? '已记录内容与事实的对应审查；未判断真实性或法院是否采纳。'
      : '尚未完成内容与事实的对应审查，不能仅凭文件名称确认事实。' }))
  const goals = internal.caseOverview.userGoals.map(g => g.description)
  if (!goals.length) goals.push(...internal.facts.filter(f => f.category === 'OTHER' && /希望|想|询问|要求/.test(f.content)).map(f => f.content))
  const summary = { caseType: internal.subtitle.replace(/案件分析$/, ''), goals,
    status: researchText[internal.researchStatus], caseSummary: short(rawCase.split(/(?<=[。！？])/u).slice(0, 3).join(''), 160) }
  const keyFindings: UserCaseReportModel['keyFindings'] = mainIssues.slice(0, 3).map(i => ({
    text: `${short(i.question, 75)} ${i.conclusion}`, questionIds: [i.questionId], applicationIds: i.applicationIds,
    factIds: i.supportingFactIds, gapIds: i.gapIds }))
  if (highGaps.length) keyFindings.push({ text: `当前主要阻碍是事实和材料尚未充分核对。最先补充：${highGaps.slice(0, 2).map(g => phrase(g.description)).join('；')}。`,
    questionIds: unique(highGaps.flatMap(g => g.questionIds)), applicationIds: unique(highGaps.flatMap(g => g.applicationIds)),
    factIds: unique(highGaps.flatMap(g => g.factIds)), gapIds: highGaps.map(g => g.id) })
  if (keyFindings.length < 3 && keyFacts.length) keyFindings.push({
    text: `当前${keyFacts.filter(f => f.support.status === 'SUPPORTED').length}项关键事实已有材料支持，${keyFacts.filter(f => f.support.status !== 'SUPPORTED').length}项仍需核对或补充材料；这不等于案件结果已经确定。`,
    questionIds: sortedQuestions.map(q => q.id), applicationIds: applications.map(a => a.applicationId),
    factIds: keyFacts.map(f => f.factId), gapIds: evidenceGaps.map(g => g.id) })
  if (keyFindings.length < 3) keyFindings.push({ text: nextActions.at(-1)!.text,
    questionIds: core.map(i => i.questionId), applicationIds: [], factIds: [], gapIds: highGaps.map(g => g.id) })
  const ruleBlocks = (id: string, full: boolean): ReportBlock[] => {
    const item = internal.ruleEvidence.find(e => e.fragment.fragmentId === id)!
    return [p(`${ruleName(item)}。${sourceStatus(item)}`),
      { kind: 'quote', text: full ? item.rule.ruleText : short(item.rule.ruleText, 100) },
      { ...p('查看法律来源'), href: item.citation.sourceUrl }]
  }
  const issueBlocks = (issue: UserCaseReportModel['legalIssues'][number], full: boolean): ReportBlock[] => [
    h(issue.question), p(`当前判断：${issue.conclusion}`),
    ...issue.coreRuleEvidenceIds.flatMap(id => ruleBlocks(id, full)),
    ...(issue.coreRuleEvidenceIds.length ? [p(`与本案的关系：${issue.whyRelated}`)] : []),
    p(`结合本案：${full ? issue.application : issue.supportingFactIds.slice(0, 2).map(id => userFact(facts.get(id)!.content)).join('；') || '尚缺具体事实'}${full ? '' : `（对应关键事实第${issue.supportingFactIds.map(id => keyFacts.findIndex(f => f.factId === id) + 1).join('、')}项）`}`),
    p(`证据状态：${issue.evidenceStatus}`),
    ...(issue.gapIds.length ? [p(`还缺什么：见证据清单第${issue.gapIds.map(id => evidenceGaps.findIndex(g => g.id === id) + 1).join('、')}项。${full ? issue.unresolvedPoints.join('；') : short(issue.unresolvedPoints[0] ?? '', 75)}`)] : []),
  ]
  const gapBlocks = (full: boolean): ReportBlock[] => evidenceGaps.flatMap((g, i) => full
    ? [h(`${i + 1}. ${g.description}`), p(`为什么重要：${g.why}`), p(`可以尝试寻找：${g.suggestions.join('；')}`),
      p(`证明目的：${g.purpose}`), p(`如果找不到：${g.alternatives.join('；') || '现有结果未提供明确替代材料，可先说明已经尝试取得哪些记录。'}`)]
    : [p(`${i + 1}. ${g.importance === 'HIGH' ? '优先补充' : '补充'}：${userFact(g.description)}。可以尝试：${g.suggestions.join('；')}。${g.alternatives.length ? `如找不到，可尝试${g.alternatives.join('；')}。` : ''}`)])
  const limitations = ['材料支持状态仅反映已有内容审查，不代表真实性鉴定或法院必然采纳。', disclaimer]
  const sections = [
    section('案件概况', [p(`${summary.caseType}。据你描述：${summary.caseSummary}`), p(`主要诉求：${goals.map(userFact).join('；') || '尚需明确希望对方具体做什么'}。`), p(summary.status)]),
    section('结论摘要', keyFindings.map(f => p(f.text))),
    section('关键事实', [...unique(keyFacts.filter(f => !isRequest(f.factId)).map(f => f.support.status)).flatMap(status => [h(factSupportText[status]),
      ...keyFacts.filter(f => !isRequest(f.factId) && f.support.status === status).map(f => p(`${keyFacts.indexOf(f) + 1}. ${userFact(f.content)}${f.basis.length ? `。相关材料：${f.basis.map(b => b.replace('（你提到持有，尚未提交原文）', '')).join('、')}` : ''}。`))]),
      ...(keyFacts.some(f => isRequest(f.factId)) ? [h('你的请求（请确认本次分析范围）'), ...keyFacts.filter(f => isRequest(f.factId)).map(f => p(`${keyFacts.indexOf(f) + 1}. ${userFact(f.content)}。`))] : [])]),
    section('核心法律问题', [...mainIssues.flatMap(i => issueBlocks(i, false)),
      ...(legalIssues.length > mainIssues.length ? [p(`另有${legalIssues.length - mainIssues.length}项问题，包括${legalIssues.filter(i => !i.inMainReport && !i.ruleEvidenceIds.length).length}项尚缺对应规则。全部问题的独立分析见配套 HTML / Markdown 附录；未展开不表示已经解决。`)] : [])]),
    section('证据与补充材料', [
      ...(assessment.items.some(e => e.file) ? assessment.workspaceGaps.map(g => p(`${g.title}：${g.status === 'SATISFIED' ? '已有材料支持（完整性由用户确认）' : g.status === 'PARTIAL' ? '部分补充' : '未补充'}。`)) : []),
      ...evidenceOverview.map(e => p(`${e.title}：${e.limitation} 可能对应：${short(e.possibleSupport.map(userFact).join('；'), 100)}`)),
      ...(!evidenceOverview.length ? [p('尚未登记案件材料；请先核对你实际持有哪些原始记录。')] : []),
      p('下面按重要性列出缺口，相关问题和证明目的见配套附录；所列材料只是寻找方向，不表示已经存在或必然被采纳。'), ...gapBlocks(false)]),
    section('下一步行动', nextActions.map((a, i) => p(`${i + 1}. ${a.text}`))),
    section('法律来源与说明', [p('正文中的“查看法律来源”链接指向官方原文。完整问题分析、证明目的、替代材料和法律原文见配套 HTML / Markdown 附录。'), ...limitations.map(p)]),
  ]
  const appendix = [section('全部法律问题', legalIssues.flatMap(i => issueBlocks(i, true))),
    section('补充材料的用途与替代方向', gapBlocks(true)),
    section('完整法律来源', internal.ruleEvidence.flatMap(e => ruleBlocks(e.fragment.fragmentId, true)))]
  return { title: '案件分析报告', subtitle: internal.subtitle, generatedAt: internal.generatedAt,
    summary, keyFindings, keyFacts, legalIssues, evidenceOverview, evidenceGaps, nextActions,
    legalSources: internal.ruleEvidence, limitations, sections, appendix,
    ...(assessment.items.some(e => e.file) ? { workspaceGaps: assessment.workspaceGaps } : {}) }
}

export function renderUserMarkdown(report: PrintableReport & { appendix: Section[] }, compact = false): string {
  const sections = (values: Section[]) => values.map(s => `## ${md(s.title)}\n\n${s.blocks.map(b =>
    b.href ? `[${md(b.text)}](<${link(b.href).replace(/[<>]/g, c => encodeURIComponent(c))}>)`
      : `${b.kind === 'heading' ? '### ' : b.kind === 'quote' ? '> ' : ''}${md(b.text)}`).join('\n\n')}`).join('\n\n')
  return `# ${md(report.title)}\n\n${md(report.subtitle)}\n\n${sections(report.sections)}${compact && !report.appendix.length ? '\n' : `\n\n# 附录\n\n${sections(report.appendix)}\n`}`
}
export function renderUserHtml(report: PrintableReport & { appendix: Section[]; reportFormat?: string }, compact = false): string {
  const v2 = report.reportFormat === 'USER_CASE_REPORT_V2'
  const compactStyle = compact ? '<style>body{max-width:780px;background:#fff;font-size:16px;line-height:1.65}header{padding:20px 24px;border-radius:8px}.report-section{padding:18px 24px;margin:14px 0;border-radius:8px}h1{font-size:28px}h2{font-size:22px;margin-bottom:14px}h3{font-size:17px;margin:18px 0 8px}blockquote{margin:10px 0;padding:12px}body .report-section:first-of-type p:nth-of-type(2){font-size:inherit;font-weight:normal}body .report-section:first-of-type p:nth-of-type(3){color:inherit;background:transparent;padding:0;border-radius:0}</style>' : ''
  const blocks = (values: ReportBlock[]) => values.map(b => b.href
    ? '<p><a href="'+html(link(b.href))+'" rel="noreferrer">'+html(b.text)+'</a></p>'
    : '<'+(b.kind === 'heading' ? 'h3' : b.kind === 'quote' ? 'blockquote' : 'p')+'>'+html(b.text)+'</'+(b.kind === 'heading' ? 'h3' : b.kind === 'quote' ? 'blockquote' : 'p')+'>').join('')
  const sections = (values: Section[]) => values.map(s => v2 && s.title.includes('（附录）')
    ? '<details class="report-section"><summary>'+html(s.title)+'</summary>'+blocks(s.blocks)+'</details>'
    : '<section class="report-section"><h2>'+html(s.title)+'</h2>'+blocks(s.blocks)+'</section>').join('')
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+html(report.title)+'</title><style>body{max-width:1000px;margin:32px auto;padding:0 20px;font:17px/1.8 system-ui;color:#202124;background:#fafafa}header{padding:28px 32px;background:#fff;border:1px solid #e4e4e7;border-radius:16px}h1{font-size:30px;line-height:1.4;margin:8px 0}header p{color:#62666c;margin:8px 0}.report-section{padding:24px 32px;background:#fff;border:1px solid #e4e4e7;border-radius:14px;margin:20px 0}h2{font-size:25px;line-height:1.45;margin:0 0 20px}h3{font-size:19px;margin:24px 0 10px;padding-top:12px;border-top:1px solid #eee}p{margin:12px 0;overflow-wrap:anywhere}blockquote{margin:16px 0;padding:16px;background:#f5f6f8;white-space:pre-wrap}a{color:#285d91;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}a:focus-visible,summary:focus-visible{outline:2px solid #285d91;outline-offset:4px}.report-section:first-of-type p:nth-of-type(2){font-size:24px;font-weight:650}.report-section:first-of-type p:nth-of-type(3){color:#83521b;background:#fff4e6;padding:10px;border-radius:8px}@media(max-width:600px){body{margin:16px auto;padding:0 12px;font-size:16px}header,.report-section{padding:20px}h1{font-size:25px}h2{font-size:22px}}@media print{body{background:#fff;font-size:11pt;max-width:none;margin:0}.report-section,header{border:0;padding:12px 0}h2,h3{break-after:avoid}details{display:block}summary{list-style:none}}</style><body><header><p>案件分析 · 事实、证据与行动</p><h1>'+html(report.title)+'</h1><p>'+html(report.subtitle)+'</p></header>'+sections(report.sections)+(report.appendix.length ? '<details class="report-section"><summary>查看全部问题、补充材料用途和法律原文</summary>'+sections(report.appendix)+'</details>' : '')+compactStyle+'</body></html>'
}
