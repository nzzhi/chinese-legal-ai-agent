import { z } from 'zod'
import { buildReport } from './reportBuilder.js'
import { questionKey } from './reportPresentation.js'
import { legalRuleApplicationSchema } from '../legalRule/legalRuleSchema.js'
import { sourceVerificationResultSchema } from '../verification/sourceVerificationSchema.js'
import { legalBasisItemSchema, type LegalBasisItem } from './userActionReportModel.js'
import type { Fact } from '../case/caseSchema.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import { evidenceStage } from '../caseEvidence/caseEvidence.js'
import { buildLoanCoreAnalysis } from './loanCoreAnalysis.js'
import { caseSchema } from '../case/caseSchema.js'
import { deriveCaseContinuation, hasBlockingConclusionGap } from '../caseEvidence/caseContinuation.js'
import type { ActionTrace, AnalysisPremise, EvidenceFamily, UserActionReportModel, ActionQuestion } from './userActionReportModel.js'

const unique = <T>(items: T[]) => [...new Set(items)]
const plainFact = (s: string) => s.replace(/^用户(?:主张|陈述|表示)(?:其)?/u, '你表示').replace(/^用户询问/u, '你想了解')
const isRequest = (f: Fact) => f.category === 'OTHER' && /希望|想|询问|要求/.test(f.content)
const evidenceNames = { CONTRACT: '合同材料', PAYMENT_RECORD: '付款记录', CHAT_RECORD: '聊天记录', AUDIO: '录音',
  VIDEO: '视频', IMAGE: '图片', RECEIPT: '收据', INVOICE: '发票', NOTICE: '通知', PLATFORM_RECORD: '平台记录', OTHER: '其他材料' }
const emptyTrace = (): ActionTrace => ({ factIds: [], evidenceIds: [], questionIds: [], ruleIds: [], applicationIds: [], gapIds: [] })
function mergeTrace(...values: ActionTrace[]): ActionTrace {
  const result = emptyTrace()
  for (const key of Object.keys(result) as Array<keyof ActionTrace>) result[key] = unique(values.flatMap(t => t[key]))
  return result
}

export function describeActionPremise(premise: AnalysisPremise): string {
  return {
    USER_ASSERTED: '按照你的描述，可以先按这一事实分析；接下来用原始记录把它证明完整。',
    PARTIAL_EVIDENCE: '现有信息已经有一定支持，建议补充完整上下文，使证据更完整。',
    NO_AUTHORITY: '目前这个问题的法律依据检索还不完整，这不等于你的事实主张被否定。',
    CONFLICTING_EVIDENCE: '现有信息存在冲突，需要重点核实双方说法与原始记录的对应关系。',
  }[premise]
}

/** Multi-label routing: a transfer mentioning the recipient/date can supply three priorities. */
export function evidenceFamilies(description: string): EvidenceFamily[] {
  const result: EvidenceFamily[] = []
  if (/转账|支付记录|付款|交付|借给|出借.*元|金额/.test(description) && !/部分还款|支付利息/.test(description)) result.push('payment')
  if (/聊天|催款|承诺|约定|借条|短信|邮件|录音/.test(description)) result.push('chat')
  if (/身份|姓名|身份证|联系方式|住址|账号.*(?:本人|归属|属于)|收款方.*本人/.test(description)) result.push('identity')
  if (/日期|时间|期限|去年|三个月|下个月|发生在/.test(description)) result.push('timeline')
  if (/部分还款|还款情况|未还款|未还|利息|已还|偿还/.test(description)) result.push('repayment')
  return result.length ? result : ['other']
}

/** Closed, deterministic question families; unfamiliar questions retain their substance. */
export function toUserQuestion(question: LegalQuestion, loan: boolean, money: string): string {
  const text = question.question
  if (loan) {
    if (/时间.*限制|时间限制|诉讼时效|起算|重新计算/.test(text)) return '拖了这么久，哪些日期需要特别留意？'
    if (/账号|身份|起诉对象/.test(text) && !/能否起诉|是否.*起诉/.test(text)) return '怎样把微信账号和对方本人对应起来？'
    if (/还款承诺|作出.*还|下个月一定还|肯定会还/.test(text)) return `他说会还这笔钱，对我有什么帮助？`
    if (/没有借条|无借条|未.*借条/.test(text)) return `没有借条，还能要回${money}吗？`
    if (/未还款|至今未还/.test(text) && /证明|举证/.test(text)) return '怎样说明对方一直没有还款？'
    if (/催款/.test(text) && !/聊天记录.*借款合意/.test(text)) return '多次催款的记录有什么用？'
    if (/转账记录/.test(text) && !/聊天记录/.test(text)) return '微信转账记录能说明什么？'
    if (/聊天记录/.test(text) && /借款合意|还款期限/.test(text)) return '聊天记录里哪些内容最有帮助？'
    if (/证据|举证/.test(text)) return '我应该怎样整理这些记录？'
    if (/起诉/.test(text)) return '准备起诉前，我需要先做好什么？'
    if (/法律后果/.test(text)) return '除了本金，我还需要核对哪些请求？'
    return `要回${money}，现在应该抓住什么？`
  }
  const labels: Partial<Record<LegalQuestion['questionType'], string>> = {
    REFUND: '我想要回的钱，需要怎样准备材料？', CONTRACT_FORMATION: '我和对方的约定，怎样证明清楚？',
    CONTRACT_PERFORMANCE: '对方没有按约定做，我该准备什么？', CONTRACT_TERMINATION: '想结束这份约定，我该先核对什么？',
    DAMAGES: '我提出赔偿前，需要整理什么？', PROCEDURE: '进一步处理前，我需要准备什么？',
    STANDARD_TERMS: '对方写的这些条款，和我有什么关系？',
  }
  return labels[question.questionType] ?? text.replace(/^在[^，]{2,25}(?:纠纷|关系)中，/u, '')
    .replace(/出借人|消费者|用户/g, '我').replace(/借款人|经营者|商家/g, '对方')
}

const familyCopy: Record<EvidenceFamily, { title: string; goal: string; need: string[]; why: string }> = {
  payment: { title: '完整转账记录', goal: '把款项金额、付款时间和收款账户对应清楚。',
    need: ['保留原始交易详情，包含金额、时间、交易单号和双方账户；核对是否显示到账或退回。'], why: '证明你实际交付了多少钱，并与双方的约定互相对应。' },
  chat: { title: '完整聊天记录', goal: '还原借款或其他约定、履行要求、催促和对方回复的完整经过。',
    need: ['备份完整会话，保留账号资料和日期；把关键对话前后上下文一起保存，避免只留单句截图。'], why: '把款项用途和双方约定讲清楚，避免断章取义。' },
  identity: { title: '对方身份与账号对应', goal: '把与你沟通、收款的人和对方本人对应起来。',
    need: ['整理已知姓名、联系方式和地址，并保存账号资料、对方自我介绍或现有往来记录。'], why: '让材料能够指向同一个人，后续处理也需要明确对象。' },
  timeline: { title: '案件时间线', goal: '按顺序对应交易、约定期限、催促和回复的日期。',
    need: ['制作日期—发生了什么—对应原始记录的表格；只有相对时间的，先保留原话，再核对记录日期。'], why: '还原事件顺序，也为后续核对期限问题提供基础。' },
  repayment: { title: '还款情况核对', goal: '说明是否存在部分返还、利息或其他已支付款项。',
    need: ['核对微信和银行入账；有部分还款的逐笔记录日期、金额和用途，没有的如实说明。'], why: '避免遗漏已还款项，准确整理剩余本金；利息另行核对约定和依据。' },
  other: { title: '其他关键材料', goal: '补齐已有记录没有覆盖的关键经过。',
    need: ['整理已有合同、履行记录及其他直接对应的原始材料，注明来源和形成时间。'], why: '让当前说法能与具体记录对应。' },
}

export function buildUserActionReport(input: unknown, now?: Date, version: '2' | '2.1' = '2'): UserActionReportModel {
  // Reuse the existing schema/graph/publication guards and derived data, NEVER their sections or UserCaseReport.
  const data = buildReport(input, now)
  const source = z.object({ rawCase: z.string(), case: caseSchema, ruleApplications: z.array(legalRuleApplicationSchema).optional(),
    candidateVerifications: z.array(z.object({ result: sourceVerificationResultSchema })) }).passthrough().parse(input)
  const apps = source.ruleApplications ?? []
  const continuation = deriveCaseContinuation({ ...source, researchStatus: data.researchStatus })
  const facts = data.facts, assessment = data.caseEvidenceAssessment
  const loan = data.subtitle.startsWith('借贷纠纷')
  const amounts = unique(facts.filter(f => !isRequest(f) && f.category === 'PAYMENT' && !/部分还|已还|利息/.test(f.content))
    .flatMap(f => [...f.content.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*元/g)].map(m => m[1].replace(/,/g, ''))))
  const money = amounts.length === 1 ? `${amounts[0]}元` : '这笔钱'
  const title = `${loan ? money + '借款' : data.subtitle.replace(/案件分析$/, '')}行动报告`
  const evidenceTitle = (id: string) => {
    const item = assessment.items.find(e => e.id === id)!
    return `${item.title ?? evidenceNames[item.type]}${assessment.items.some(e => e.file) ? `（${evidenceStage(item, assessment.items)}）` : item.source === 'USER_REPORTED' ? '（你提到持有）' : item.source === 'FILE_REFERENCE' ? '（已登记文件）' : '（已提供文字）'}`
  }
  const traceFor = (factIds: string[], questionIds: string[] = []): ActionTrace => {
    const relevant = apps.filter(a => questionIds.includes(a.legalQuestionId)
      || (questionIds.length === 0 && a.relatedFactIds.some(id => factIds.includes(id))))
    return { factIds: unique(factIds), questionIds: unique(questionIds),
      evidenceIds: assessment.items.filter(e => e.relatedFactIds.some(id => factIds.includes(id))).map(e => e.id),
      applicationIds: relevant.map(a => a.applicationId), ruleIds: unique(relevant.map(a => a.legalRuleId)), gapIds: [] }
  }
  // A generated dispute topic or UNKNOWN support is not contradictory evidence.
  const conflictingIds = new Set([
    ...facts.filter(f => f.certainty === 'DISPUTED').map(f => f.id),
    ...data.caseOverview.disputedFacts.filter(d => d.opposingPosition && d.opposingPosition !== d.userPosition).flatMap(d => d.relatedFactIds),
  ])
  // Only explicit complete-repayment contradictions are recognized; partial repayment is not a contradiction.
  const repaid = loan ? facts.filter(f => /(?:已经|已)(?:全部|全额)?还清/.test(f.content)) : []
  const neverRepaid = loan ? facts.filter(f => /一直未还|至今仍未还|至今未还|从未还|尚未还款/.test(f.content)) : []
  const selfConflict = repaid.length > 0 && neverRepaid.length > 0
  if (selfConflict) [...repaid, ...neverRepaid].forEach(f => conflictingIds.add(f.id))
  const premiseFor = (ids: string[], hasAuthority = true): AnalysisPremise => {
    if (ids.some(id => conflictingIds.has(id))) return 'CONFLICTING_EVIDENCE'
    if (ids.some(id => assessment.factSupports.some(f => f.factId === id && ['PARTIAL', 'SUPPORTED'].includes(f.status)))) return 'PARTIAL_EVIDENCE'
    return hasAuthority ? 'USER_ASSERTED' : 'NO_AUTHORITY'
  }
  const knownFacts = facts.filter(f => !isRequest(f) && f.certainty !== 'UNKNOWN' && !conflictingIds.has(f.id))
  const traceKnown = traceFor(knownFacts.map(f => f.id))
  // ponytail: literal fact cues for presentation; ambiguous wording needs richer fact semantics, never inferred proof.
  const transferred = knownFacts.filter(f => f.category === 'PAYMENT' && /转账|借给|支付|付款/.test(f.content)
    && !/未还|利息|部分还|(?:没有|未|从未|不曾).*(?:转账|付款|支付|借给)|转账失败|付款失败|已退回/.test(f.content))
  const promises = knownFacts.filter(f => /承诺|一定还|肯定会还|三个月后还/.test(f.content) && !/(?:没有|未|拒绝).*承诺/.test(f.content))
  const reminders = knownFacts.filter(f => /催款|催还|催促/.test(f.content) && !/(?:没有|未|从未).*催/.test(f.content))
  const unpaid = knownFacts.filter(f => /未还|没还/.test(f.content))
  const favorablePoints: UserActionReportModel['favorablePoints'] = []
  const addPoint = (title: string, explanation: string, selected: Fact[], caveat: string) => {
    if (!selected.length) return
    const trace = traceFor(selected.map(f => f.id))
    favorablePoints.push({ title, explanation, relatedFacts: selected.map(f => plainFact(f.content)),
      relatedEvidence: trace.evidenceIds.map(evidenceTitle), verificationCaveat: caveat, trace })
  }
  if (loan) {
    const wechatTransfer = transferred.some(f => /微信/.test(f.content))
    const importedPayment = assessment.items.find(e => e.file?.confirmationStatus === 'CONFIRMED' && e.type === 'PAYMENT_RECORD')
    addPoint(`你描述了${money}${wechatTransfer ? '微信' : ''}转出`, '转账能帮助说明款项已经交付；与借款聊天相互对应，比孤立的一张截图更有帮助。', transferred,
      importedPayment ? '系统已读取登记的转账内容，用户已确认关键信息；仍需保留原始交易详情，真实性未鉴定。'
        : '保留交易详情，把金额、时间和收款人对应完整；这里按你的陈述分析，尚未独立核验原始记录。')
    addPoint('对方作出还款承诺', '如果完整聊天能确认对方是在回应本案款项，还款承诺有助于说明这笔钱需要返还，而不是普通赠与。', promises,
      '核对承诺前后的对话、发言账号和日期，保留原话。')
    addPoint(reminders.some(f => /多次|很多次|反复/.test(f.content)) ? '你有多次催款的经过' : '你有催款的经过',
      '催款和对方回复能连起借款、到期后追讨及承诺还款的过程。', reminders, '整理每次催款日期和对应回复，不把催款本身当成全部法律条件已经满足。')
    addPoint('你表示至今未获还款', '这说明你目前仍在追讨款项；下一步应核对入账，准确整理尚欠金额。', unpaid, '如有部分还款或支付利息，单独列出，避免重复计算。')
    const materialFacts = knownFacts.filter(f => assessment.items.some(e => e.relatedFactIds.includes(f.id)))
    const materialTypes = new Set(assessment.items.map(e => e.type))
    const imported = assessment.items.filter(e => e.file && e.file.confirmationStatus !== 'REJECTED')
    addPoint(imported.length ? '案件材料已导入系统' : materialTypes.has('PAYMENT_RECORD') && materialTypes.has('CHAT_RECORD') ? '你提到持有转账和聊天材料' : '你提到持有相关原始材料',
      '已有记录可以帮助还原交付款项、双方约定和催款经过，便于把你的说法与具体记录对应。', materialFacts,
      imported.length ? imported.map(e => `${e.title}：${evidenceStage(e)}`).join('；') + '。用户确认仅登记内容，不代表真实性鉴定或法院采信。'
        : '你提到持有这些记录；本报告还没有独立核验原始内容。')
  } else {
    addPoint('你描述了付款经过', '付款记录可以帮助还原已支付金额、时间和收款对象，再与合同或沟通内容对应。', transferred, '保存原始付款记录和完整上下文。')
    const agreements = knownFacts.filter(f => f.category === 'CONTRACT')
    addPoint('你说明了双方的约定', '约定的具体内容是对照双方实际行为的起点。', agreements, '保留合同或完整沟通，不只摘录有利的句子。')
    addPoint('你已经与对方沟通', '沟通记录可以还原你提出了什么请求，以及对方如何回应。', knownFacts.filter(f => f.category === 'COMMUNICATION'), '把请求和回复一起保存。')
  }
  const factContext = knownFacts.map(f => f.content).join('；')
  const overdue = /逾期|已到期|到期.*未还|还款期限.*已过/.test(factContext)
    || /去年/.test(factContext) && /三个月后还/.test(factContext) && (now ?? new Date()).getUTCMonth() >= 3
  let assessmentText = loan && transferred.length
    ? `按照你目前提供的信息，这是一起${/朋友/.test(factContext) ? '朋友之间' : ''}${money}借款${unpaid.length && overdue ? '逾期未还' : unpaid.length ? '未还' : ''}的纠纷。`
    : `按照你目前提供的信息，可以先按${data.subtitle.replace(/案件分析$/, '')}整理这件事。`
  const quotes = unique(promises.flatMap(f => [...f.content.matchAll(/“([^”]+)”/g)].map(m => `“${m[1]}”`)))
  if (loan && transferred.length) assessmentText += `${transferred.some(f => /微信/.test(f.content)) ? '你描述了微信转账' : '你描述了款项交付'}${reminders.length ? '和催款经过' : ''}${quotes.length ? `，并提到对方说过${quotes.join('、')}` : promises.length ? '，并提到对方承诺还款' : ''}。这些信息如果能通过完整原始记录核验，对证明借款和还款义务是有帮助的。`
  else assessmentText += knownFacts.slice(0, 3).map(f => plainFact(f.content)).join('；') || '先写清发生了什么、希望对方做什么，再逐项对应已有记录。'
  const attentionPoints: UserActionReportModel['attentionPoints'] = data.caseOverview.disputedFacts
    .filter(d => d.opposingPosition && d.opposingPosition !== d.userPosition)
    .map(d => ({ title: '双方说法存在差异', explanation: `${d.topic}：你说“${d.userPosition ?? '需补充你的具体说法'}”，对方说“${d.opposingPosition}”。请把各自说法与原始记录对应。`, trace: traceFor(d.relatedFactIds) }))
  if (selfConflict) attentionPoints.push({ title: '还款描述前后不一致',
    explanation: `你同时提到“${plainFact(repaid[0].content)}”和“${plainFact(neverRepaid[0].content)}”。请核对是否在说同一笔款项及同一时段。`,
    trace: traceFor([...repaid, ...neverRepaid].map(f => f.id)) })
  for (const f of facts.filter(f => f.certainty === 'DISPUTED' && !attentionPoints.some(p => p.trace.factIds.includes(f.id)))) {
    attentionPoints.push({ title: '这部分经过有争议', explanation: `${plainFact(f.content)}。请核对原始记录与双方说法。`, trace: traceFor([f.id]) })
  }
  if (attentionPoints.length) assessmentText += '其中有具体说法存在争议，请先核对下列冲突；其余陈述仍作为当前分析前提。'

  const gapMap = new Map<string, UserActionReportModel['appendix']['evidenceGaps'][number]>()
  const putGap = (description: string, purpose: string, suggestions: string[], trace: ActionTrace, priority: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH') => {
    const key = questionKey(description), previous = gapMap.get(key)
    if (previous) {
      previous.trace = mergeTrace(previous.trace, trace)
      if (priority === 'HIGH' || previous.priority === 'LOW') previous.priority = priority
    } else gapMap.set(key, { description, purpose, suggestions, trace, priority })
  }
  for (const gap of assessment.evidenceGaps) putGap(facts.find(f => f.id === gap.factId)!.content,
    gap.purpose, gap.suggestedEvidence, { ...traceFor([gap.factId], gap.legalQuestionIds), gapIds: [gap.id] }, gap.importance)
  for (const [index, gap] of assessment.factQuestions.entries()) putGap(gap.question, '把这部分经过说明清楚并与原始记录对应。',
    ['先如实说明，再核对对应原始记录。'], { ...emptyTrace(), gapIds: [`fact-question-${index + 1}`] }, gap.importance)
  for (const app of apps) for (const [index, gap] of app.evidenceGaps.entries()) putGap(gap,
    '补齐当前法律问题实际需要的记录。', ['核对该事项的完整原始记录。'],
    { ...traceFor(app.relatedFactIds, [app.legalQuestionId]), gapIds: [`application-gap-${app.applicationId}-${index + 1}`] })
  for (const gap of data.materialGaps.filter(g => g.kind === 'DISPUTED_FACT')) putGap(gap.description, gap.whyItMatters,
    gap.suggestedEvidence, { ...traceFor(gap.relatedFactIds, gap.legalQuestionIds), gapIds: [gap.id] })
  const allGaps = [...gapMap.values()]
  const grouped = new Map<EvidenceFamily, ActionTrace>()
  for (const gap of allGaps) {
    if (gap.priority === 'LOW') continue
    if (gap.trace.factIds.length === 1 && isRequest(facts.find(f => f.id === gap.trace.factIds[0])!)) continue
    for (const family of evidenceFamilies(gap.description)) grouped.set(family, mergeTrace(grouped.get(family) ?? emptyTrace(), gap.trace))
  }
  if (assessment.items.some(e => e.file)) for (const gap of assessment.workspaceGaps) {
    if (!grouped.has(gap.family)) grouped.set(gap.family, { ...emptyTrace(), evidenceIds: gap.evidenceIds, gapIds: [gap.id] })
  }
  const evidencePriorities: UserActionReportModel['evidencePriorities'] = (['payment', 'chat', 'identity', 'timeline', 'repayment', 'other'] as const)
    .filter(family => grouped.has(family)).map(family => {
      const copy = familyCopy[family], trace = grouped.get(family)!
      const matches = assessment.items.filter(e => family === 'payment' ? e.type === 'PAYMENT_RECORD'
        : family === 'chat' ? ['CHAT_RECORD', 'AUDIO', 'NOTICE'].includes(e.type) : trace.evidenceIds.includes(e.id))
      const relevantFacts = knownFacts.filter(f => evidenceFamilies(f.content).includes(family))
      const alreadyHave = matches.map(e => evidenceTitle(e.id))
      const workspaceGap = assessment.items.some(e => e.file) ? assessment.workspaceGaps.find(g => g.family === family) : undefined
      if (!alreadyHave.length && relevantFacts.length) alreadyHave.push(...relevantFacts.slice(0, 2).map(f => plainFact(f.content)))
      return { family, title: family === 'payment' && /微信转账/.test(source.rawCase) ? '完整微信转账记录'
        : family === 'chat' && /微信/.test(source.rawCase) ? '完整微信聊天记录' : copy.title,
      ...(workspaceGap ? { status: workspaceGap.status, evidenceIds: workspaceGap.evidenceIds, missingFields: workspaceGap.missingFields } : {}),
      proofGoal: copy.goal, alreadyHave: alreadyHave.length ? alreadyHave : ['这部分具体记录尚未登记，可先说明你已掌握的信息。'],
      recommendedEvidence: workspaceGap?.status === 'SATISFIED' ? ['本轮材料已补充，继续保存原件与完整上下文；内容确认不代表真实性鉴定。'] : copy.need,
      importance: copy.why, trace: mergeTrace(trace, traceFor(relevantFacts.map(f => f.id))) }
    })

  const legalBasis: UserActionReportModel['legalBasis'] = data.ruleEvidence.map(item => {
    const rule = item.rule, relatedApps = apps.filter(a => a.legalRuleId === rule.ruleId)
    const relatedIds = unique(relatedApps.flatMap(a => a.relatedFactIds)), selected = facts.filter(f => relatedIds.includes(f.id) && !isRequest(f))
    let simpleExplanation = rule.ruleText
    let caseRelevance = `这条规定与${selected.length ? `你描述的“${plainFact(selected[0].content)}”` : '这个问题中的约定和实际行为'}对应，需要逐项对照规定的条件。`
    if (/自然人之间的借款合同.*提供借款时成立/.test(rule.ruleText)) {
      simpleExplanation = '个人之间借款，实际交付款项是借款成立的重要条件。'
      caseRelevance = `如果${money}转账能对应到对方实际收款，这条规定与借款成立问题直接相关；同时保留双方借款约定的聊天。`
    } else if (/按照约定的期限返还借款/.test(rule.ruleText)) {
      simpleExplanation = '借款应按约定期限返还；期限没有约定或仍不明确的，需要结合补充约定和催告情况。'
      caseRelevance = '把最初约定、后来的还款承诺和催款日期放在一起，便于核对双方的还款时间安排。'
    } else if (/利息不得预先在本金中扣除/.test(rule.ruleText)) {
      simpleExplanation = '不能先从本金里扣利息；若预先扣了，应按实际提供的款项计算。'
      caseRelevance = `整理${money}主张时，要区分实际转出金额和约定金额；没有预扣利息的，不额外假设发生了扣款。`
    } else if (/借款合同是借款人向贷款人借款/.test(rule.ruleText)) {
      simpleExplanation = '借款的核心是借入款项并按约定返还；利息是否约定应另外核对。'
      caseRelevance = '把转账和对方承诺归还的聊天对应起来，有助于说明款项用途；不能仅凭这条定义断言你能获得利息。'
    }
    return { name: `《${rule.legalName}》${rule.article}`, simpleExplanation, caseRelevance,
      officialSource: item.citation.sourceUrl, originalText: rule.ruleText,
      caveat: rule.legalStatus.status === 'VERIFIED' && rule.legalStatus.value !== 'EFFECTIVE'
        ? `原研究记录标记这条规定${rule.legalStatus.value === 'REPEALED' ? '已废止' : '尚未生效'}，不能直接作为当前请求的现行依据。`
        : rule.legalStatus.status !== 'VERIFIED' || rule.version.status !== 'VERIFIED' ? '这条规定的效力或适用版本还需核对。' : '',
      trace: { ...traceFor(relatedIds, relatedApps.map(a => a.legalQuestionId)), ruleIds: [rule.ruleId] } }
  })

  const allQuestions: ActionQuestion[] = data.legalQuestions.map(q => {
    const trace = traceFor(q.relatedFactIds, [q.id])
    const basis = legalBasis.filter(r => r.trace.questionIds.includes(q.id))
    const premise = premiseFor(q.relatedFactIds, basis.length > 0)
    const userFacingQuestion = toUserQuestion(q, loan, money)
    let shortAnswer = '先按你描述的经过分析，把约定、实际行为和你的请求对应清楚。'
    let explanation = '围绕这个问题整理直接对应的原始记录，再核对相关规定中的条件。'
    if (loan) {
      if (/没有借条/.test(userFacingQuestion)) {
        shortAnswer = `没有借条不等于你的借款说法被否定。现在的重点是把${money}转账与借款、还款聊天对应完整。`
        explanation = '先说明这笔钱为什么转出、对方为何承诺归还，再核对身份和时间；不因没有借条就把你陈述的借款当作不存在。'
      } else if (/他说/.test(userFacingQuestion)) {
        shortAnswer = '如果承诺是在回应这笔借款，对说明款项需要归还是有帮助的。'
        explanation = '保留承诺前后的完整对话和日期，核对是否在讨论新的还款安排；不要只截取一句话。'
      } else if (/账号/.test(userFacingQuestion)) {
        shortAnswer = '把收款账号、聊天账号和对方身份信息连起来。'
        explanation = '先用你已有的往来、账号资料和对方自我介绍逐项对应，再补充现有记录缺少的身份信息。'
      } else if (/日期/.test(userFacingQuestion)) {
        shortAnswer = '先准确列出借款、到期、催款和承诺还款日期。'
        explanation = '这些日期是核对期限问题的基础；当前未检索完整对应依据，不在这里计算或断言期限届满。'
      } else if (/转账记录/.test(userFacingQuestion)) {
        shortAnswer = '它帮助说明交付金额、时间和收款对象，还应与借款沟通一起看。'
        explanation = '保存交易详情和完整聊天，分别对应“钱转给了谁”和“为什么要还”。'
      } else if (/聊天|催款/.test(userFacingQuestion)) {
        shortAnswer = '借款约定、还款承诺、催款和回复的上下文最值得保存。'
        explanation = '把关键对话按日期与转账对应，不改写原文；单独催款不能代替对全部条件的核对。'
      } else if (/没有还款/.test(userFacingQuestion)) {
        shortAnswer = '按你的描述，款项尚未归还；请核对是否有任何部分还款。'
        explanation = '整理催款回复与账户入账记录，逐笔扣除实际收到的款项，不把材料未登记当作已经还款。'
      } else if (/本金/.test(userFacingQuestion)) {
        shortAnswer = '先把实际交付和剩余本金算清楚，利息及其他请求分别核对。'
        explanation = '保留利息约定和付款记录，没有明确约定或对应依据的，不补写可获支持的金额。'
      } else {
        shortAnswer = `先把${money}的交付、借款约定、还款安排和未还经过连成一条记录。`
        explanation = '备份转账和聊天，整理时间线、对方身份及剩余金额；材料整理完成后，核对起诉条件和受理法院。'
      }
    }
    const published = data.supportedClaims.filter(c => c.support.legalQuestionId === q.id)
    if (published.length) shortAnswer = published.map(c => c.claim).join('；')
    if (premise === 'CONFLICTING_EVIDENCE') shortAnswer = describeActionPremise(premise)
    explanation += ` ${describeActionPremise(premise)}`
    // Evidence support and authority completeness are independent, never a single UNKNOWN label.
    if (basis.length === 0 && premise !== 'NO_AUTHORITY') explanation += ` ${describeActionPremise('NO_AUTHORITY')}`
    const affectedGaps = continuation.gaps.filter(g => g.questionIds.includes(q.id) || g.factIds.some(id => q.relatedFactIds.includes(id)))
    if (affectedGaps.length) explanation += ` 缺失影响：${unique(affectedGaps.map(g => g.title)).join('；')}。这一问题的判断需保留条件，待补充核验。`
    if (hasBlockingConclusionGap(continuation, q.id)) {
      shortAnswer = '核心交易或事件经过尚未说明，暂不输出依赖这些事实的确定性结论；可以先整理补充清单。'
    }
    return { userFacingQuestion, shortAnswer, explanation, legalBasis: basis, relatedEvidence: trace.evidenceIds.map(evidenceTitle), premise, trace }
  })
  const groupedQuestions = new Map<string, ActionQuestion>()
  for (const q of allQuestions) {
    const previous = groupedQuestions.get(q.userFacingQuestion)
    if (!previous) groupedQuestions.set(q.userFacingQuestion, { ...q })
    else {
      previous.trace = mergeTrace(previous.trace, q.trace)
      previous.legalBasis = unique([...previous.legalBasis, ...q.legalBasis])
      previous.relatedEvidence = unique([...previous.relatedEvidence, ...q.relatedEvidence])
      if (q.premise === 'CONFLICTING_EVIDENCE') { previous.shortAnswer = q.shortAnswer; previous.explanation = q.explanation; previous.premise = q.premise }
    }
  }
  const questionOrder = (q: ActionQuestion) => /没有借条/.test(q.userFacingQuestion) ? 0 : /他说/.test(q.userFacingQuestion) ? 1
    : /整理/.test(q.userFacingQuestion) ? 2 : /日期/.test(q.userFacingQuestion) ? 3 : 4
  const userQuestions = [...groupedQuestions.values()].sort((a, b) => questionOrder(a) - questionOrder(b)).slice(0, 4)
  const actionTrace = (families: EvidenceFamily[]) => mergeTrace(...evidencePriorities.filter(p => families.includes(p.family)).map(p => p.trace))
  const nextActions: UserActionReportModel['nextActions'] = [
    { title: '先备份完整原始记录', instruction: loan ? '备份完整聊天和转账详情，保留原始设备或文件；把还款承诺前后的会话一起保存。' : '备份现有合同、支付、履行和沟通原始记录，保留完整上下文。', trace: actionTrace(['payment', 'chat', 'other']) },
    { title: '整理案件时间线', instruction: loan ? '按借款、约定到期、每次催款、承诺还款逐项写日期，并对应到原始记录。' : '按约定、付款、履行、提出请求和对方回复逐项写日期，并对应到原始记录。', trace: actionTrace(['timeline', 'chat']) },
    { title: '整理对方身份信息', instruction: '汇总已知姓名、联系方式、地址和账号资料，把聊天对象与收款对象对应起来。', trace: actionTrace(['identity']) },
    { title: loan ? '核对还款和利息' : '核对请求及已支付款项', instruction: loan ? '逐笔检查微信和银行入账，列出部分还款及利息；如无还款，如实记录，计算剩余本金。' : '写清希望对方具体做什么；把已付款、已退款和其他款项分别记录，避免重复计算。', trace: actionTrace(['repayment', 'payment']) },
    { title: '材料整理后进入诉讼准备', instruction: '带上完整记录、时间线、对方身份和金额表，核对起诉条件、受理法院及对应法律依据，再决定如何提交材料。', trace: mergeTrace(traceKnown, ...evidencePriorities.map(p => p.trace)) },
  ]
  const researchLimitations = ['报告先以你的陈述作为分析前提；材料内容支持、真实性和最终裁判是不同问题。']
  if (allQuestions.some(q => q.legalBasis.length === 0)) researchLimitations.push('部分问题的法律依据仍不完整，尤其不能把现有材料整理建议当作起诉条件或期限已核对完毕。')
  if (legalBasis.some(r => r.caveat)) researchLimitations.push('部分规定的效力或版本仍需核对，完整边界保留在详细资料中。')
  const report: UserActionReportModel = { version, caseTitle: title, generatedAt: data.generatedAt,
    continuation,
    currentAssessment: { text: assessmentText, premise: '以你的陈述作为当前分析前提；材料核验用于把事情证明完整。', trace: traceKnown },
    favorablePoints, attentionPoints, evidencePriorities, userQuestions, nextActions, legalBasis, researchLimitations,
    ...(assessment.items.some(e => e.file) ? { caseMaterials: assessment.items.filter(e => e.file).map(e => {
      const activeIds = assessment.links.filter(l => l.evidenceId === e.id && l.status !== 'CANCELLED').map(l => l.factId)
      return {
      evidenceId: e.id, title: e.title ?? evidenceNames[e.type], stage: evidenceStage(e),
      relatedFactIds: activeIds, relatedFacts: activeIds.map(id => facts.find(f => f.id === id)!.content) } }) } : {}),
    appendixRef: { label: '查看详细问题、完整补充事项和法律原文' },
    appendix: { allQuestions, evidenceGaps: allGaps, facts, factSupports: assessment.factSupports, legalSources: data.ruleEvidence } }
  if (version === '2') return report

  // buildReport already checks the exact snapshot/Rule/Authority graph and hashes.
  // A verified court-page quote alone does not prove that a full article was retained.
  const basisItems = new Map<string, LegalBasisItem>()
  for (const [index, entry] of data.ruleEvidence.entries()) {
    const rule = entry.rule, authority = rule.source.authority, basis = legalBasis[index]
    const verification = source.candidateVerifications.find(e => e.result.verificationId === rule.source.verificationId)!.result
    const verified = verification.status === 'VERIFIED' && verification.checks.completeness.status === 'VERIFIED'
      && rule.ruleTextVerification.status === 'VERIFIED' && rule.legalStatus.status === 'VERIFIED'
      && rule.legalStatus.value === 'EFFECTIVE' && rule.version.status === 'VERIFIED'
    const complete = !!authority && authority.article.text === entry.citation.exactQuote
    const status = !verified ? 'UNVERIFIED' : !complete ? 'INCOMPLETE_TEXT' : 'VERIFIED'
    const relatedApps = apps.filter(a => a.legalRuleId === rule.ruleId)
    const sourceHost = new URL(entry.citation.sourceUrl).hostname
    const sourceName = sourceHost === 'zrzyt.fujian.gov.cn' ? '福建省自然资源厅（官方法律法规转载页）'
      : sourceHost === 'www.court.gov.cn' ? '最高人民法院官网' : `官方公开来源（${sourceHost}）`
    const item = legalBasisItemSchema.parse({
      authorityId: authority?.article.id ?? rule.source.providerSourceId,
      lawName: rule.legalName, articleNumber: rule.article,
      articleText: status === 'VERIFIED' ? authority!.article.text : '',
      sourceName: `${sourceName}${authority ? `；制定机关：${authority.document.issuingAuthority}` : ''}`,
      sourceUrl: entry.citation.sourceUrl, verificationStatus: status,
      verificationDetails: { sourceStatus: verification.status, articleCompleteness: complete ? 'COMPLETE' : 'NOT_STORED',
        ruleTextStatus: rule.ruleTextVerification.status,
        legalStatus: rule.legalStatus.status === 'VERIFIED' ? rule.legalStatus.value : rule.legalStatus.status,
        versionStatus: rule.version.status },
      verificationExplanation: status === 'VERIFIED'
        ? `完整条文、来源、现行效力和版本已按原研究记录核验（${verification.checkedAt}）；${relatedApps.some(a => a.status === 'UNKNOWN') ? '本案适用性尚未完成审查，不代表案件事实或还款请求已获确认。' : relatedApps.some(a => a.status === 'VERIFIED_NOT_APPLICABLE') ? '原研究含不适用审查记录，不能直接作为本案请求已获支持的依据。' : '本案结论仍须满足材料核验与原研究发布条件。'}`
        : status === 'INCOMPLETE_TEXT' ? '该问题的法律依据尚未完整核验。原研究没有保存可确认完整的法条原文；已定位摘录不能冒充完整法条。'
        : '该问题的法律依据尚未完整核验。来源、现行效力或版本核验尚未完成，不能按完整已核验依据展示。',
      versionIdentifier: rule.version.status === 'VERIFIED' ? rule.version.identifier : '', verifiedAt: verification.checkedAt,
      relatedQuestionIds: basis.trace.questionIds, relatedRuleIds: [rule.ruleId],
      relatedApplicationIds: relatedApps.map(a => a.applicationId), relatedFactIds: basis.trace.factIds,
      relatedEvidenceIds: basis.trace.evidenceIds,
      relatedFacts: facts.filter(f => basis.trace.factIds.includes(f.id)).map(f => plainFact(f.content)),
      relatedEvidence: basis.trace.evidenceIds.map(evidenceTitle), relevanceExplanation: basis.caseRelevance,
      evidenceExplanation: '这些材料用于把条文中的条件与案件经过对应；材料登记或你提到持有，不代表原始内容及真实性已核验。',
      sourceTrace: [{ candidateSourceId: rule.source.candidateSourceId, verificationId: rule.source.verificationId,
        retrievalId: rule.source.retrievalId, sourceContentHash: rule.source.sourceContentHash, ruleEvidenceId: entry.fragment.fragmentId }],
    })
    const key = JSON.stringify([item.authorityId, item.lawName, item.articleNumber, item.articleText,
      item.sourceUrl, item.versionIdentifier, item.verificationStatus])
    const previous = basisItems.get(key)
    if (!previous) basisItems.set(key, item)
    else {
      for (const field of ['relatedQuestionIds', 'relatedRuleIds', 'relatedApplicationIds', 'relatedFactIds',
        'relatedEvidenceIds', 'relatedFacts', 'relatedEvidence'] as const) previous[field] = unique([...previous[field], ...item[field]])
      previous.sourceTrace.push(...item.sourceTrace)
      previous.relevanceExplanation = unique([previous.relevanceExplanation, item.relevanceExplanation]).join(' ')
      previous.verificationExplanation = unique([previous.verificationExplanation, item.verificationExplanation]).join(' ')
    }
  }
  report.legalBasisItems = [...basisItems.values()]
  // Keep the original v2 fields and trace, but never use them as a v2.1 original-text fallback.
  for (const q of [...report.userQuestions, ...report.appendix.allQuestions]) {
    const related = report.legalBasisItems.filter(b => b.relatedQuestionIds.some(id => q.trace.questionIds.includes(id)))
    q.legalBasisIds = unique(related.map(b => b.authorityId))
    q.explanation = q.explanation.replace(describeActionPremise('NO_AUTHORITY'), '').trim()
    if (q.trace.questionIds.some(id => !related.some(b => b.verificationStatus === 'VERIFIED' && b.relatedQuestionIds.includes(id)))) {
      q.explanation += `${related.some(b => b.verificationStatus === 'VERIFIED') ? ' 以下条文原文已核验，但这个问题还涉及尚未核验的法律条件。' : ''} 目前这个问题的法律依据尚未完整核验。`
    }
  }
  if (loan && assessment.items.some(e => e.file)) {
    report.loanCoreAnalysis = buildLoanCoreAnalysis(data, apps, money,
      Object.fromEntries(data.legalQuestions.map(q => [q.id, toUserQuestion(q, loan, money)])))
    const coreRuleIds = new Set(report.loanCoreAnalysis.topics.flatMap(t => t.ruleIds))
    // The core presentation has a smaller scope; the original research graph/appendix
    // remain intact, and an unrelated promoted rule is not a basis for this demo request.
    report.legalBasisItems = report.legalBasisItems.filter(b => b.relatedRuleIds.some(id => coreRuleIds.has(id)))
    report.currentAssessment.text = report.loanCoreAnalysis.summary
    report.nextActions = report.loanCoreAnalysis.nextActions.map(a => ({ title: '按当前分析继续核对', instruction: a.instruction,
      trace: { ...emptyTrace(), factIds: a.factIds, ruleIds: a.ruleIds, gapIds: a.gapIds } }))
    if (report.loanCoreAnalysis.simulated) report.researchLimitations.unshift('SIMULATED / DEMO ONLY · 模拟材料，仅用于产品演示和测试；本报告不代表真实案件证据或胜诉判断。')
  }
  return report
}
