import { z } from 'zod'
import { caseSchema, type Fact } from '../case/caseSchema.js'
import { disputeAnalysisSchema } from '../classification/classificationSchema.js'
import { evidenceStage, isConfirmedLink, type CaseEvidenceAssessment } from '../caseEvidence/caseEvidence.js'
import type { CaseContinuation } from '../caseEvidence/caseContinuation.js'
import type { ReportModel, ReportBlock } from './reportModel.js'
import type { ComplaintDraft, EvidenceDirectoryEntry } from './userAnswerExperience.js'
import type { ConditionalResearchReport } from './conditionalResearchReport.js'
import type { ActionTrace } from './userActionReportModel.js'
import { sourceVerificationResultSchema } from '../verification/sourceVerificationSchema.js'

const unique = <T>(values: T[]) => [...new Set(values)]
const p = (text: string): ReportBlock => ({ kind: 'paragraph', text })
const h = (text: string): ReportBlock => ({ kind: 'heading', text })
const trace = (factIds: string[] = []): ActionTrace => ({ factIds, evidenceIds: [], questionIds: [], ruleIds: [], applicationIds: [], gapIds: [] })
const readable = (text: string) => text.replace(/^用户(?:称|表示|陈述)(?:其)?/u, '你表示').replace(/^用户/u, '你')
const request = (f: Fact) => /(?:希望|要求|请求|想要|能否|能不能).{0,30}(?:返还|退还|退款|退费|赔偿|归还|支付|解除|维权)/.test(f.content)
const simulated = (text: string) => /SIMULATED|TEST[ _]DATA|模拟|演示|合成材料/i.test(text)

/** Proof themes are material-preparation guidance, never an inferred legal rule. */
const themes = [
  { key: 'agreement', title: '约定与交易性质', match: (f: Fact) => f.category === 'CONTRACT' || /出借|借给|肯定会还|一定还|还款承诺/.test(f.content),
    why: '先说明双方为何发生这笔交易、约定了什么，避免只凭付款判断交易性质。', need: '完整约定、合同或同期沟通，包含双方身份、交易内容及前后上下文。', objection: '交易性质或约定内容与双方理解不同' },
  { key: 'payment', title: '付款、实际收款与金额', match: (f: Fact) => f.category === 'PAYMENT' && !/未还|未退|没(?:有)?还|返还|退还/.test(f.content),
    why: '把实际付款、收款对象和请求金额对应起来；付款记录本身不能说明所有约定。', need: '原始付款详情、交易时间和状态、双方账户、实际到账记录，以及账户与交易对象的对应材料。', objection: '实际收款金额或收款对象与陈述不一致' },
  { key: 'performance', title: '履行、到期与未解决部分', match: (f: Fact) => ['SERVICE', 'TERMINATION', 'EVENT'].includes(f.category) || /个月后|到期|未还|未退|没(?:有)?还|清洁|维修|扣除/.test(f.content),
    why: '确认何时应当履行、已履行多少，以及目前仍未解决的部分。', need: '履行时间线、使用或交接记录、已还款或已退款记录，以及与当前未履行部分有关的沟通。', objection: '已履行、已返还或存在需要核对的扣减' },
  { key: 'communication', title: '沟通、承诺与回应', match: (f: Fact) => f.category === 'COMMUNICATION',
    why: '完整对话能帮助核对请求、承诺和争议，单句截图可能缺少前提。', need: '保存完整会话、日期、双方账号及请求和回应原文；如有不利回复一并保留。', objection: '关键沟通被截取，或账号与当事人不对应' },
  { key: 'identity', title: '交易对象与责任主体', match: (f: Fact) => f.category === 'PARTY',
    why: '确定需要向谁提出请求，并核对付款、合同和沟通中是否为同一主体。', need: '可区分对方的姓名或主体名称、账号及对应来源；具体提交信息要求需另核对程序依据。', objection: '合同、收款或沟通主体并非同一个责任主体' },
] as const

export function projectUserCaseV2(input: unknown, assessment: CaseEvidenceAssessment, policy: CaseContinuation,
  internal: ReportModel | undefined, conditional: ConditionalResearchReport | undefined, draft: ComplaintDraft,
  directory: EvidenceDirectoryEntry[], priorityGaps: Array<{ priority: string; title: string; titles: string[]; action: string; ids: string[] }>,
  notice: string, now: Date, legacyRuleIds?: string[]) {
  const data = z.object({ case: caseSchema, rawCase: z.string().optional(), disputeAnalysis: disputeAnalysisSchema.optional() }).parse(input)
  const facts = data.case.facts.concat(data.case.disputedFacts)
  const factsById = new Map(facts.map(f => [f.id, f]))
  const text = facts.map(f => f.content).join('；')
  const loan = /借款|出借|借给|借条/.test(text), rental = /租赁|房东|退租/.test(text), prepaid = /课程|私教|套餐|预付/.test(text) && !loan && !rental
  const relation = loan ? '借款往来' : rental ? '租赁与押金返还' : prepaid ? '预付服务与未履行部分的退费' : '双方约定、履行和责任'
  const goals = unique([...internal?.caseOverview.userGoals.map(g => g.description) ?? [], ...facts.filter(request).map(f => f.content)])
  const explicitGoals = facts.filter(request).map(f => f.content)
  const claimText = (explicitGoals.length ? explicitGoals : goals).map(readable).join('；') || (loan ? '核对借款返还请求（具体请求范围请确认）' : '具体请求尚需你确认')
  const allSimulated = simulated(data.case.id + ' ' + (data.rawCase ?? ''))
  const amountFacts = facts.filter(f => ['PAYMENT', 'CONTRACT', 'DISPUTE', 'OTHER'].includes(f.category) && f.certainty !== 'UNKNOWN')
  const amounts = unique(amountFacts.flatMap(f => [...f.content.matchAll(/(?<![\d.])(\d[\d,]*(?:\.\d{1,2})?)\s*元/g)].map(m => m[1])))
  const amount = amounts.length === 1 ? `${amounts[0]}元` : amounts.length ? amounts.map(a => `${a}元`).join(' / ') : '尚待确认'
  const legalStatus = conditional ? `${conditional.acceptedCount}/${conditional.questionCount} 个问题已形成条件分析` : policy.researchStatus === 'NOT_STARTED' ? '法律研究尚未开始' : '已有研究，适用与发布条件仍需核对'
  const stage = policy.researchStatus === 'COMPLETE' && policy.filingReadiness === 'READY' && policy.evidenceReadiness === 'READY'
    // Signature/date remain placeholders until the user signs; they do not block a preparation report.
    && draft.status !== 'NOT_APPROPRIATE' && !allSimulated && !assessment.items.some(e => simulated(`${e.title ?? ''} ${e.content ?? ''}`))
    && !!internal?.supportedClaims.some(c => c.support.claimType === 'LEGAL_CONCLUSION')
    ? '诉讼准备报告（仍需本人检查）' : assessment.items.some(e => e.content && e.file?.confirmationStatus !== 'REJECTED') || conditional?.acceptedCount
      ? '证据与法律分析' : '初步案件分析'
  const accepted = conditional?.questions.filter(q => q.analysis) ?? []
  const electronic = facts.some(f => f.category === 'PAYMENT' && /微信|支付宝|转账|电子汇款/.test(f.content))
  const unrelatedPaymentPath = (condition: string) => electronic && /现金|票据|账户支配权|账户实际支配权|其他方式提供借款/.test(condition)
  const questionTrace = (ids: string[]) => unique(conditional?.questions.filter(q => q.question.relatedFactIds.some(id => ids.includes(id))).map(q => q.question.id)
    ?? internal?.legalQuestions.filter(q => q.relatedFactIds.some(id => ids.includes(id))).map(q => q.id) ?? [])
  const points = themes.map(t => {
    const related = facts.filter(f => !request(f) && t.match(f)), ids = related.map(f => f.id)
    const tr = trace(ids); tr.questionIds = questionTrace(ids)
    tr.evidenceIds = unique(assessment.items.filter(e => e.file?.confirmationStatus !== 'REJECTED' && e.relatedFactIds.some(id => ids.includes(id))).map(e => e.id))
    tr.gapIds = policy.gaps.filter(g => g.factIds.some(id => ids.includes(id))).map(g => g.id)
    const conditions = accepted.flatMap(q => q.analysis!.applications.flatMap(a => {
      const rule = q.analysis!.normativeIR.rules.find(r => r.ruleId === a.ruleId)!
      const branches = rule.branches.filter(b => !b.conditionGroups.some(g => g.conditions.some(n => unrelatedPaymentPath(n.text))))
      const visibleIds = new Set([...rule.scope, ...rule.assessmentFactors, ...branches.flatMap(b => [...b.conditionGroups.flatMap(g => g.conditions), ...b.exceptions])].map(n => n.nodeId))
      return a.conditionAssessments.filter(c => visibleIds.has(c.conditionId) && c.factIds.some(id => ids.includes(id)))
        .map(c => ({ condition: c, questionId: q.question.id, ruleId: a.ruleId, applicationId: a.applicationId }))
    }))
    tr.questionIds = unique([...tr.questionIds, ...conditions.map(c => c.questionId)])
    tr.ruleIds = unique(conditions.map(c => c.ruleId)); tr.applicationIds = unique(conditions.map(c => c.applicationId))
    const missing = t.key === 'performance' ? loan ? '核对借款日期、具体到期日、催收日期、已还款金额与未还余额；保存收款流水及完整还款沟通。'
      : rental ? '保存退租、钥匙交还及房屋交接记录、交房时照片；请对方列明清洁维修项目、金额、约定及实际支出依据，核对真实损坏情况。'
        : prepaid ? '核对购买和已使用次数、预约或核销记录、闭店时间和通知、替代服务及已退款情况；保存课程价格构成与退费约定。' : t.need
      : t.key === 'agreement' && rental ? '完整租赁合同及押金、交房、清洁维修和扣费约定。'
        : t.key === 'agreement' && prepaid ? '课程确认、完整购买约定和价格构成；如含赠课或优惠，保存当时规则。'
          : t.key === 'identity' && !related.length ? '补充可区分交易对象的姓名或主体名称、账号及对应来源；具体提交要求需核对程序依据。' : t.need
    const factualReasoning = t.key === 'agreement' && loan ? '借款约定与还款承诺如果由完整真实聊天支持，可以用来说明款项的借款性质；仅有转账不能说明全部约定。'
      : t.key === 'payment' ? '把付款详情、实际到账与同一收款主体对应核对，可以支撑交付款项的事实论证；金额仍需扣除已返还部分，并与具体请求对应。'
        : t.key === 'performance' && prepaid ? '购买记录与核销记录对应，可用于说明已使用和剩余服务；闭店及后续安排用于核对未履行部分，剩余次数不能直接确定退费金额。'
          : t.key === 'performance' && rental ? '退租和交还记录用于说明履行结束及交接情况；将扣费约定、实际状态与费用凭证逐项比对，才能整理押金余额的事实理由。'
            : t.key === 'performance' && loan ? '还款约定、到期日期和实际收款流水对应，可用于整理到期未还与余额的事实理由；催收和再次承诺的时间仍需核对。'
              : `${t.why} 用原始材料逐项对应上面的陈述，才能把你的请求展开为可核对的事实理由。`
    const conclusion = conditions.length ? '现有陈述与部分已验证规则条件有关联；只能形成待真实材料核验的论证，不能视为条件已经满足。'
      : '可以先整理这一事实论证；对应法律适用尚未通过完整验证，暂不写成确定的法律理由。'
    return { key: t.key, title: t.title, claim: claimText, claimFactIds: facts.filter(request).map(f => f.id), why: t.why, facts: related, evidenceIds: tr.evidenceIds, missing, reasoning: factualReasoning, conclusion,
      conditions: unique(conditions.map(c => c.condition.condition)),
      authorityRefs: [...new Map(conditions.flatMap(c => c.condition.legalSupport).map(ref => [JSON.stringify(ref), ref])).values()], trace: tr }
  }).filter(t => t.facts.length || t.key === 'identity')

  // Only accepted analyses supply Authority/Application. Shared Fact IDs establish trace relevance, never applicability.
  type Law = { name: string; article: string; url: string; fetchedAt: string; trace: ActionTrace; question: string; quotes: string[]; prerequisites: string[]; sourceOnly?: boolean }
  const laws = [...new Map<string, Law>(accepted.flatMap(q => q.analysis!.rules.flatMap(r => r.ir.authorityRefs.map(ref => {
    const source = conditional!.sources.find(s => s.verificationId === ref.verificationId)!
    return [`${source.sourceUrl}:${source.article}`, { name: source.title, article: source.article, url: source.sourceUrl,
      fetchedAt: source.fetchedAt, trace: { ...trace(unique(q.analysis!.applications.filter(a => a.ruleId === r.ruleId).flatMap(a => a.conditionAssessments.flatMap(c => c.factIds)))),
        questionIds: [q.question.id], ruleIds: [r.ruleId], applicationIds: q.analysis!.applications.filter(a => a.ruleId === r.ruleId).map(a => a.applicationId) },
      question: q.question.question, quotes: [ref.quote], prerequisites: [] }] as [string, Law]
  })))).values()]
  // Merge every citation edge instead of losing earlier rules at the same law/article.
  for (const law of laws) {
    const refs = accepted.flatMap(q => q.analysis!.rules.flatMap(r => r.ir.authorityRefs.filter(ref => {
      const source = conditional!.sources.find(s => s.verificationId === ref.verificationId)
      return source?.sourceUrl === law.url && source.article === law.article
    }).map(ref => ({ q, r, ref }))))
    const relevantQuotes = points.flatMap(pt => pt.authorityRefs).filter(ref => refs.some(v => v.ref.verificationId === ref.verificationId)).map(ref => ref.quote)
    law.quotes = unique(relevantQuotes).filter(quote => !unrelatedPaymentPath(quote))
    law.trace.ruleIds = unique(refs.map(v => v.r.ruleId)); law.trace.questionIds = unique(refs.map(v => v.q.question.id))
    law.trace.applicationIds = unique(refs.flatMap(v => v.q.analysis!.applications.filter(a => a.ruleId === v.r.ruleId).map(a => a.applicationId)))
    law.trace.factIds = unique(refs.flatMap(v => v.q.analysis!.applications.filter(a => a.ruleId === v.r.ruleId).flatMap(a => a.conditionAssessments.flatMap(c => c.factIds))))
    law.trace.evidenceIds = unique(assessment.items.filter(e => e.relatedFactIds.some(id => law.trace.factIds.includes(id))).map(e => e.id))
    law.prerequisites = unique(refs.flatMap(v => [...v.r.ir.scope.map(n => n.text), ...v.r.ir.branches.flatMap(b => b.conditionGroups.flatMap(g => g.conditions))
      .filter(n => v.r.ir.branches.every(b => b.conditionGroups.some(g => g.conditions.some(c => c.nodeId === n.nodeId)))).map(n => n.text)]))
  }
  // Legacy qualified quotations retain source visibility, without claiming independent entailment or case applicability.
  if (!conditional) for (const item of internal?.ruleEvidence.filter(item => !legacyRuleIds || legacyRuleIds.includes(item.rule.ruleId)) ?? []) {
    if (laws.some(l => l.url === item.citation.sourceUrl && l.article === item.rule.article)) continue
    laws.push({ name: item.rule.legalName, article: item.rule.article, url: item.citation.sourceUrl, fetchedAt: item.rule.source.authority?.document.fetchedAt ?? '原保存快照（时间见内部研究记录）',
      trace: { ...trace(), ruleIds: [item.rule.ruleId], questionIds: internal!.issueAssessments.filter(i => i.ruleEvidenceIds.includes(item.fragment.fragmentId)).map(i => i.legalQuestionId) }, sourceOnly: true,
      question: '相关规范原文；本案完整条件适用尚待核查', quotes: [], prerequisites: ['来源正文核对不等于独立蕴含或本案适用通过'] })
  }
  const recordedOpposition = (position: string, ids: string[]) => {
    // ponytail: exact first substantive clause only; paraphrases need a clarified recorded Fact before becoming real objections.
    const clause = position.replace(/^(?:对方|朋友|房东|商家|负责人|经营者|被告).*?(?:表示|称|说|主张|回复)/, '').split(/[，,；;。]/)[0].replace(/\s/g, '')
    return ids.some(id => {
      const content = factsById.get(id)?.content ?? ''
      return !/可能|假设|是否|未提出|没有提出/.test(content) && /(?:对方|朋友|房东|商家|负责人|经营者|被告).{0,12}(?:表示|称|说|主张|回复|拒绝)/.test(content)
        && clause.length >= 6 && content.replace(/\s/g, '').includes(clause)
    })
  }
  const objections: Array<{ title: string; statement: string; status: 'RECORDED' | 'HYPOTHETICAL'; preparation: string; trace: ActionTrace }> = (data.disputeAnalysis?.disputedFacts.filter(d => d.opposingPosition && recordedOpposition(d.opposingPosition, d.relatedFactIds)) ?? []).map(d => ({ title: d.topic,
    statement: d.opposingPosition!, status: 'RECORDED' as const, preparation: '保存双方完整说法，逐项核对约定、发生经过、金额和对应原始材料；保留真实的不利记录。', trace: trace(d.relatedFactIds) }))
  for (const point of points.filter(pt => pt.facts.some(f => f.certainty !== 'UNKNOWN')).slice(0, 3)) {
    if (objections.some(o => o.trace.factIds.some(id => point.trace.factIds.includes(id)))) continue
    objections.push({ title: themes.find(t => t.key === point.key)!.objection, statement: '仅为回应准备的假设；没有记录表明对方已经这样反驳。',
      status: 'HYPOTHETICAL', preparation: point.missing, trace: structuredClone(point.trace) })
  }
  for (const objection of objections) objection.trace.evidenceIds = unique(assessment.items.filter(e => e.relatedFactIds.some(id => objection.trace.factIds.includes(id))).map(e => e.id))
  const materialAnalysis = assessment.items.filter(e => e.file?.confirmationStatus !== 'REJECTED').map(e => {
    const links = assessment.links.filter(l => l.evidenceId === e.id && isConfirmedLink(l)), sim = simulated(`${e.title ?? ''} ${e.content ?? ''} ${e.sourceReference ?? ''}`)
    return { evidenceId: e.id, name: e.title ?? e.description ?? '已登记材料', source: e.sourceReference ?? '用户登记',
      status: evidenceStage(e, assessment.items), simulated: sim,
      facts: e.relatedFactIds.map(id => factsById.get(id)!),
      supportedContent: links.length ? links.map(l => `用户核对关联：${l.purpose}；原文：“${l.quote}”`) : ['尚无用户核对的事实关联。'],
      limit: sim ? 'SIMULATED / TEST DATA：仅供演示，不能支持真实案件事实；待材料核验。' : '关联确认只核对内容；真实性、完整性、账户归属与法院证明力仍需核验；待材料核验。',
      need: !e.content ? `上传或登记${e.type === 'PAYMENT_RECORD' ? '原始付款详情' : e.type === 'CHAT_RECORD' ? '完整会话原文' : '该材料原文'}，并核对完整上下文和证明目的。`
        : '保留原件与来源，核对上下文、主体对应以及是否存在相反记录。', trace: { ...trace(e.relatedFactIds), evidenceIds: [e.id] } }
  })
  const actions = [
    ...policy.gaps.filter(g => g.disposition === 'BLOCKING' && g.impacts.some(i => i.capability === 'RESEARCH')).map(g => ({ title: g.title,
      instruction: g.nextAction, why: g.reason, prepares: '当前事实陈述或待核对材料', resolves: '完成后可解除相应研究启动限制；仍不证明事实。', trace: { ...trace(g.factIds), gapIds: [g.id] } })),
    ...points.map(pt => ({ title: `核对${pt.title}`, instruction: pt.missing, why: pt.why,
      prepares: pt.evidenceIds.map(id => materialAnalysis.find(e => e.evidenceId === id)?.name).filter(Boolean).join('、') || '与你陈述对应的原始记录',
      resolves: '更新该项事实与材料状态；材料变化后按快照规则重新研究或生成报告。', trace: pt.trace })),
    { title: '明确请求并保存对方回复', instruction: `整理“${claimText}”的具体范围和计算过程；如联系对方，保存请求、回复和日期。`,
      why: '把目前未解决的事项和双方分歧写清楚。', prepares: '请求清单、往来记录及金额核对表', resolves: '为协商和后续文书准备事实；具体投诉、调解或诉讼渠道仍需程序核查。', trace: trace(facts.filter(request).map(f => f.id)) },
    { title: '核查法律与程序后再决定是否起诉', instruction: '未解决时继续核对请求依据、相对方和管辖；先检查准备草稿的待补字段及证据目录。',
      why: '材料整理完成不等于满足全部实体或立案条件。', prepares: '准备草稿、证据目录、尚未完成的研究问题', resolves: '核查完成并由本人确认后，再评估提交及导出。', trace: trace() },
  ]
  const summaryFacts = facts.filter(f => !request(f) && !['UNKNOWN', 'DISPUTED'].includes(f.certainty) && f.category !== 'OTHER')
  const countFacts = facts.filter(f => /\d+次/.test(f.content))
  const purchased = countFacts.filter(f => /购买|购入/.test(f.content)).flatMap(f => [...f.content.matchAll(/(\d+)次/g)].map(m => Number(m[1])))
  const used = countFacts.filter(f => f.category === 'SERVICE' && /已经|已上|已使用/.test(f.content)).flatMap(f => [...f.content.matchAll(/(\d+)次/g)].map(m => Number(m[1])))
  const count = prepaid && unique(purchased).length === 1 && unique(used).length === 1 && purchased[0] >= used[0]
    ? `按你陈述的次数计算：${purchased[0]} − ${used[0]} = ${purchased[0] - used[0]}次尚未使用。这是次数核对，不是可退金额；价格构成、约定及退款法律依据仍需核查。` : ''
  const researchGaps = conditional?.questions.filter(q => !q.analysis).map(q => ({ question: q.question.question, status: q.status, id: q.question.id })) ?? []
  const sections: ReportModel['sections'] = [
    { title: '一、案件概述', blocks: [p(`主要诉求：${claimText}`), p(`涉及金额（用户陈述，尚非法律核验支持金额）：${amount}`),
      p(`当前阶段：${stage}；研究状态：${legalStatus}`), p(`更新时间：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`),
      ...(allSimulated ? [p('SIMULATED / TEST DATA：本案为模拟案件。')] : []), p(`根据你目前的描述：${summaryFacts.slice(0, 6).map(f => readable(f.content)).join('；') || '基本经过尚待补充。'}`), ...(count ? [p(count)] : [])] },
    { title: '二、案件分析与初步结论', blocks: [p(`这起纠纷可以先围绕${relation}分析，重点是“${claimText}”。这是对当前陈述的初步理解，不是经过核验的法律适用结论。`),
      p(`值得核对的有利线索：${points.filter(pt => pt.facts.length).slice(0, 3).map(pt => `${pt.title}有相关陈述`).join('；') || '尚缺具体交易经过'}；有利线索不等于事实已经证明。`),
      p(conditional?.acceptedCount ? `${legalStatus}。已验证的条件分析仅解释其对应问题，不能推广为全部请求已获支持。` : '尚未完成对应法律研究中的完整条件适用；先核对事实和原始材料，法律结论留待研究。'),
      ...(internal?.supportedClaims.filter(c => c.support.claimType === 'LEGAL_CONCLUSION').map(c => p(`通过既有结论发布检查的主张：${c.claim}`)) ?? []),
      ...(prepaid ? [p('未履行服务及剩余次数可以作为请求核对的起点；专项预付消费规范及退款请求的完整适用链仍待补齐，合同内容不明确的条件分析不能单独确定退款范围。')] : []),
      ...(loan ? [p('付款详情用于核对实际交付；借款约定和还款承诺用于核对款项性质。还需分别核对到期日期、已还金额及借款人身份，不能从借款成立分析直接推出全部返还请求。')] : []),
      ...(rental ? [p('押金支付、退租和交还记录是核对返还请求的起点。清洁维修项目、房屋交接状态和扣费依据仍待核查；对方提到扣费不等于损坏已经发生，也不能据此直接确认全额返还。')] : []),
      h('关键不确定因素'), ...unique(data.case.unknownFacts.filter(f => f.importance === 'HIGH').map(f => f.question)).slice(0, 4).map(p), p('用户陈述可继续作为初步分析前提；待材料核验后，再更新相关事实与适用判断。'), p(notice)] },
    { title: '三、己方主张与法律论证', blocks: points.flatMap(pt => [h(pt.title), p(`为什么重要：${pt.why}`),
      p(`目前掌握：${pt.facts.map(f => {
        const reviewed = assessment.links.some(l => l.factId === f.id && isConfirmedLink(l) && !materialAnalysis.find(e => e.evidenceId === l.evidenceId)?.simulated)
        return `${f.certainty === 'UNKNOWN' ? '尚待核对' : f.certainty === 'DISPUTED' ? '争议陈述' : reviewed ? '已有用户核对的材料内容（真实性未核验）' : '仅有用户陈述（内容核对不等于证实）'}：${readable(f.content)}`
      }).join('；') || '尚无具体信息。'}`),
      p(`关联材料：${pt.evidenceIds.map(id => { const e = materialAnalysis.find(e => e.evidenceId === id)!; return `${e.name}（${e.simulated ? 'SIMULATED，不能证明真实事实' : e.status}）` }).join('；') || '尚无对应材料导入。'}`),
      p(`对应法律条件：${pt.conditions.slice(0, 3).join('；') || '对应规则尚未通过完整验证。'}`),
      ...(pt.authorityRefs.length ? [p(`对应依据：${unique(pt.authorityRefs.map(ref => { const s = conditional!.sources.find(s => s.verificationId === ref.verificationId)!; return `${s.title} ${s.article}` })).join('；')}`)] : []),
      p(`如何支持诉求：${pt.reasoning}`), p(`有限结论：${pt.conclusion}`), p(`还需核对：${pt.missing}`)]) },
    { title: '四、相关法律依据', blocks: [p('来源正文核验与本案适用是两个不同门槛；通过完整条件分析链的依据与仅有来源原文的依据分别标注。'),
      ...(laws.length ? laws.flatMap(l => [h(`${l.name} · ${l.article}`), p(`与本案的关系：用于核对“${l.question}”，不独立证明你的全部请求。`),
        p(l.sourceOnly ? '当前仅展示已有合格规范的来源线索；尚未形成通过独立蕴含与条件适用检查的结论。' : '已通过规则、独立蕴含及条件适用检查；事实与材料尚须核验，结论仍为条件式。'),
        p(`相关内容（核验原文摘录）：${l.quotes.slice(0, 3).join('；') || '对应原文和全部条件见折叠附录及内部报告。'}`), p(`适用前提：${l.prerequisites.join('；')}。分支条件、例外及限制仍须逐项核对；完整结构保留在内部报告。`),
        p(`来源正文快照已核对；来源获取时间：${l.fetchedAt}；未重新联网核验现行效力。案件适用仍为条件式。`), { ...p('查看官方来源'), href: l.url }]) : [p('尚无通过完整条件分析链的法律依据；未通过蕴含或适用检查的草稿不会补作法律理由。')])] },
    { title: '五、争议焦点与可能抗辩', blocks: [p('以下区分已记录的对方说法与假设性争议；回应须以真实材料为基础，保留不利记录，不保证被法院采纳。'),
      ...objections.flatMap(o => [h(`${o.status === 'RECORDED' ? '已记录说法（据现有陈述）' : '可能争议（假设）'}：${o.title}`), p(o.statement), p(`回应准备：${o.preparation}`),
        p(`可核对的现有材料：${o.trace.evidenceIds.map(id => materialAnalysis.find(e => e.evidenceId === id)?.name).filter(Boolean).join('、') || '尚未导入对应材料。'}`)]),
      ...(!objections.length ? [p('现有事实不足以预测具体抗辩；先记录真实分歧及双方原文。')] : [])] },
    { title: '六、证据分析与材料补充', blocks: [p('围绕待证事实核对材料；“用户确认关联”只表示核对了内容，不代表真实性鉴定或法院认可。'),
      ...materialAnalysis.flatMap(e => [h(e.name), p(`来源：${e.source}；当前状态：${e.status}`), p(`希望证明：${e.facts.map(f => readable(f.content)).join('；') || '具体证明目的待确认。'}`),
        p(`当前内容支持：${e.supportedContent.join('；')}`), p(`限制：${e.limit}`), p(`需补充：${e.need}`)]),
      ...directory.filter(e => !materialAnalysis.some(m => m.evidenceId === e.evidenceId)).flatMap(e => [h(e.name), p(`状态：${e.status}；证明用途：${e.purpose}`), p(`需补充：${e.need}`)]),
      h('按待证事项合并的补充清单'), ...points.map(pt => p(`${pt.title}：${pt.missing}`)),
      p('识别被告所需信息和具体提交要求应分别核查；身份证号码不在本报告中被设为所有民事案件的绝对立案必填项。')] },
    { title: '七、具体维权行动方案', blocks: actions.flatMap((a, i) => [h(`${i + 1}. ${a.title}`), p(`要做什么：${a.instruction}`),
      p(`为什么：${a.why}`), p(`准备材料：${a.prepares}`), p(`完成后：${a.resolves}`)]) },
    { title: '八、起诉准备', blocks: [p(draft.status === 'NOT_APPROPRIATE' ? '目前尚不适合输出可用民事草稿，先补充基本经过或核查前置程序。' : '可以整理带占位的民事起诉状准备草稿；这不表示已准备完成或已经满足立案要求。'),
      p(`可填内容：已有陈述、具体请求和已登记证据目录；身份字段仅使用明确且唯一的标签信息。现有${directory.length}项材料登记，不表示证据齐备。`),
      p(`待确认字段：${draft.missingFields.join('、')}`), p(`草稿准备状态：${policy.filingReadiness === 'READY' ? '信息准备较齐，仍需检查' : policy.filingReadiness === 'BLOCKED' ? '关键主体信息尚缺；仅可整理占位草稿' : '尚需补充信息'}`),
      p(`尚未完成的法律或程序问题：${researchGaps.length ? researchGaps.length + '项，完整问题见折叠附录' : '提交前仍需核对请求依据、金额、主体及管辖。'}`),
      p('本人应检查事实是否准确、诉讼请求和金额计算、证据原件及来源、法院名称和签署信息；未研究的法律理由保留待补。'), { ...p('法院公开办事入口（本提纲为项目自拟，非官方模板）'), href: draft.template.url }] },
  ]
  // All formats consume the same sections. HTML collapses these by title; DOCX/PDF retain them in print.
  sections.push({ title: '完整法律问题（附录）', blocks: (conditional?.questions ?? internal?.legalQuestions.map(question => ({ question, status: 'NOT_RUN' })) ?? [])
    .flatMap(q => [h(q.question.question), p(q.status === 'CONDITIONAL' ? '已形成条件分析，事实与材料仍需核验。' : q.status === 'BLOCKED' ? '研究受阻，尚未形成可用适用结论。' : '尚未完成法律适用研究。')]) })
  sections.push({ title: '其他待核对信息（附录）', blocks: unique(data.case.unknownFacts.map(f => f.question)).map(p) })
  sections.push({ title: '当前事实完整记录（附录）', blocks: facts.map(f => p(`${f.certainty === 'UNKNOWN' ? '待核对' : f.certainty === 'DISPUTED' ? '存在争议' : '现有陈述'}：${f.content}`)) })
  const sources = z.object({ candidateVerifications: z.array(z.object({ result: sourceVerificationResultSchema })).default([]) }).parse(input)
  sections.push({ title: '法律原文与核验记录（附录）', blocks: laws.flatMap(l => {
    const source = sources.candidateVerifications.map(v => v.result.verifiedSource).find(s => s?.sourceUrl === l.url && s.authority?.article.articleNumber === l.article)
    return [h(`${l.name} ${l.article}`), { kind: 'quote' as const, text: source?.content ?? '原文见内部报告。' },
      p('来源核验不等于案件适用，条件分析不等于确定法律结论。'), { ...p('官方来源'), href: l.url }]
  }) })
  return { title: `${allSimulated ? 'SIMULATED · ' : ''}用户案件报告`, subtitle: `${relation} · ${stage}`, generatedAt: now.toISOString(),
    reportFormat: 'USER_CASE_REPORT_V2' as const, stage, summary: { name: relation, goals, amount, amountStatus: 'USER_STATED' as const,
      amountFactIds: amountFacts.map(f => f.id), legalStatus, simulated: allSimulated },
    argumentPoints: points, legalBasis: laws, objections, materialAnalysis, actions, researchGaps,
    complaintDraft: draft, evidenceDirectory: directory, priorityGaps, sections, appendix: [] }
}
