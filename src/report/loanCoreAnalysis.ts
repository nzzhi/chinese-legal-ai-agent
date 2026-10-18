import { z } from 'zod'
import type { ReportModel } from './reportModel.js'
import type { LegalRuleApplication } from '../legalRule/legalRuleSchema.js'
import { isPaymentReceived } from '../caseEvidence/caseEvidence.js'

const ids = z.array(z.string().min(1))
const conditionSchema = z.strictObject({
  requirement: z.string().min(1), ruleIds: ids,
  stance: z.enum(['MATERIAL_SUPPORTED', 'USER_STATED', 'GAP', 'CONFLICT']),
  factIds: ids, evidenceIds: ids, gapIds: ids,
  facts: z.array(z.strictObject({ factId: z.string(), content: z.string(),
    stance: z.enum(['USER_STATED', 'CONFIRMED_STATE', 'GAP', 'CONFLICT']) })),
  support: z.array(z.strictObject({ evidenceId: z.string(), factId: z.string(), quote: z.string(),
    degree: z.enum(['PARTIAL', 'SUPPORTED']), contentConfirmed: z.literal(true), simulated: z.boolean() })),
  uncertainty: z.array(z.string()),
})
export const loanCoreAnalysisSchema = z.strictObject({
  simulated: z.boolean(), summary: z.string().min(1),
  topics: z.array(z.strictObject({ key: z.string(), question: z.string(), questionIds: ids,
    ruleIds: ids, applicationIds: ids, coverage: z.enum(['RULE_AVAILABLE', 'INSUFFICIENT_AUTHORITY']),
    status: z.enum(['CONDITIONAL', 'UNKNOWN']), conditions: z.array(conditionSchema),
    conclusion: z.string().min(1) })).length(6),
  gaps: z.array(z.strictObject({ id: z.string(), description: z.string(), factIds: ids, evidenceIds: ids })),
  nextActions: z.array(z.strictObject({ instruction: z.string(), gapIds: ids, factIds: ids, ruleIds: ids })),
})
export type LoanCoreAnalysis = z.infer<typeof loanCoreAnalysisSchema>

const unique = <T>(values: T[]) => [...new Set(values)]
const simulated = (content = '', filename = '') => /^SIMULATED\s*\/\s*DEMO ONLY(?:\s|$)/i.test(content)
  || /^SIMULATED[-_ ]/i.test(filename)

/** A report projection of already validated Rules and explicit user links, never a Fact selector
 * or an applicability review. Material support cannot establish truth or a court outcome.
 * ponytail: six closed loan conditions; other legal domains keep their existing reports.
 */
export function buildLoanCoreAnalysis(data: ReportModel, apps: LegalRuleApplication[], money: string,
  questionLabels: Record<string, string>): LoanCoreAnalysis {
  const assessment = data.caseEvidenceAssessment
  const isSimulated = assessment.items.some(e => simulated(e.content, e.file?.filename))
  const rules = data.ruleEvidence.map(e => e.rule).filter(r => r.source.authority
    && r.ruleTextVerification.status === 'VERIFIED' && r.legalStatus.status === 'VERIFIED'
    && r.legalStatus.value === 'EFFECTIVE' && r.version.status === 'VERIFIED')
  const definitions = [
    { key: 'agreement', question: '双方是否有借款约定？', law: '中华人民共和国民法典', articles: ['第六百七十九条'],
      requirement: '双方属于自然人借款，存在借款合意，并实际提供借款。', consequence: '自然人之间的借款合同有成立基础', field: 'borrowing', family: 'chat' },
    { key: 'delivery', question: `${money}是否已实际交付？`, law: '中华人民共和国民法典', articles: ['第六百七十九条'],
      requirement: '贷款人实际提供的是本案款项，收款对象与借款相对方对应。', consequence: '可支持借款已实际提供这一成立条件', field: 'amount', family: 'payment' },
    { key: 'return', question: '到期后是否有返还本金的基础？', law: '中华人民共和国民法典', articles: ['第六百七十五条'],
      requirement: '约定期限已届满，核对后续有无变更及尚未返还的本金。', consequence: '可形成按约要求返还剩余本金的基础', field: 'repaymentAgreement', family: 'chat' },
    { key: 'promise', question: '聊天中的还款承诺有什么证明意义？', law: '最高人民法院关于民事诉讼证据的若干规定', articles: ['第十四条', '第九十三条'],
      requirement: '承诺指向本案款项，账号、日期、完整上下文和电子数据真实性可核对。', consequence: '聊天可以作为电子数据供审查，承诺内容可辅助证明；不等于所有争议均已证明', field: 'promise', family: 'chat' },
    { key: 'form', question: '没有借条是否当然不能主张返还？', law: '中华人民共和国民法典', articles: ['第六百六十八条'],
      requirement: '双方属于自然人借款且另有形式约定，借款合意与交付有对应材料。', consequence: '没有书面借条不当然排除借款主张；合意和交付仍需证明', field: 'borrowing', family: 'chat' },
    { key: 'identity', question: '起诉前需要确认哪些主体信息？', law: '中华人民共和国民事诉讼法', articles: ['第一百二十四条'],
      requirement: '核对起诉状需要记明的被告姓名、性别、工作单位、住所等信息，并把当前账号对应到该主体；其他起诉条件另行核对。', consequence: '可用于准备起诉状主体信息，尚不代表全部起诉条件齐备', field: 'mapping', family: 'identity' },
  ] as const
  // Reuse the report's existing question labels to name uncovered questions. This is
  // presentation only: material bindings still require the original Rule applications.
  const labelPatterns: Record<string, RegExp> = { form: /没有借条/, promise: /他说会还/, identity: /微信账号/ }
  const fieldNames: Record<string, string> = { amount: '金额', time: '时间', transactionId: '交易单号', payer: '付款方',
    recipient: '收款方', result: '交易状态', participants: '对话参与人', keyQuotes: '关键原文', name: '姓名',
    account: '账号', mapping: '账号与主体对应关系', source: '材料来源' }
  // These are current assessed gaps, not a fixed list of missing documents.
  const gaps: LoanCoreAnalysis['gaps'] = [
    ...assessment.workspaceGaps.filter(g => g.status !== 'SATISFIED').map(g => ({ id: g.id,
      description: `${g.title}：${g.missingFields.map(f => fieldNames[f] ?? f).join('、')}`, factIds: [] as string[], evidenceIds: g.evidenceIds })),
    ...assessment.evidenceGaps.map(g => ({ id: g.id, description: `${data.facts.find(f => f.id === g.factId)!.content}：${g.reason}`,
      factIds: [g.factId], evidenceIds: g.evidenceIds })),
    ...assessment.factQuestions.map((g, i) => ({ id: `fact-question-${i + 1}`, description: g.question,
      factIds: [] as string[], evidenceIds: [] as string[] })),
  ]
  const topics = definitions.map(def => {
    const selected = rules.filter(r => r.legalName === def.law && (def.articles as readonly string[]).includes(r.article))
    const relatedApps = apps.filter(a => a.status !== 'VERIFIED_NOT_APPLICABLE' && selected.some(r => r.ruleId === a.legalRuleId))
    const sourceQuestionIds = relatedApps.map(a => a.legalQuestionId)
    const questionIds = unique([...sourceQuestionIds, ...data.legalQuestions.filter(q =>
      labelPatterns[def.key]?.test(questionLabels[q.id] ?? '')).map(q => q.id)])
    const declared = new Set(data.legalQuestions.filter(q => sourceQuestionIds.includes(q.id)).flatMap(q => q.relatedFactIds))
    const links = assessment.links.filter(l => declared.has(l.factId) && (l.status === 'CONFIRMED' || l.status === undefined)
      && l.review && assessment.items.some(e => e.id === l.evidenceId && e.content?.includes(l.quote)
        && e.file?.confirmationStatus === 'CONFIRMED' && e.file.contextComplete && e.file.fields[def.field]
        && (def.key !== 'delivery' || e.type === 'PAYMENT_RECORD' && isPaymentReceived(e.file.fields.result ?? '')
          && e.file.fields.amount.replace(/\s|元/g, '') === money.replace(/\s|元/g, ''))))
    const factIds = [...declared]
    // Never choose a new Fact from wording or events. Only the existing question IDs and
    // explicit material links supply bindings. Unknown/disputed content is not rescued.
    const facts = data.facts.filter(f => factIds.includes(f.id)).map(f => ({ factId: f.id, content: f.content,
      stance: f.certainty === 'DISPUTED' ? 'CONFLICT' as const : f.certainty === 'UNKNOWN' ? 'GAP' as const
        : f.certainty === 'CONFIRMED' ? 'CONFIRMED_STATE' as const : 'USER_STATED' as const }))
    const conflict = facts.some(f => f.stance === 'CONFLICT') || data.caseOverview.disputedFacts.some(d =>
      d.opposingPosition && d.opposingPosition !== d.userPosition && d.relatedFactIds.some(id => factIds.includes(id)))
    const support = links.filter(l => facts.some(f => f.factId === l.factId && !['GAP', 'CONFLICT'].includes(f.stance))).map(l => {
      const e = assessment.items.find(e => e.id === l.evidenceId)!
      return { evidenceId: e.id, factId: l.factId, quote: l.quote, degree: l.support,
        contentConfirmed: true as const, simulated: simulated(e.content, e.file?.filename) }
    })
    const coverage = def.articles.every(article => selected.some(r => r.article === article))
      ? 'RULE_AVAILABLE' as const : 'INSUFFICIENT_AUTHORITY' as const
    const topicGaps = gaps.filter(g => g.factIds.some(id => declared.has(id)) || g.evidenceIds.some(id => links.some(l => l.evidenceId === id))
      || def.family === 'identity' && assessment.workspaceGaps.some(w => w.id === g.id && w.family === 'identity'))
    const uncertainty = topicGaps.map(g => g.description)
    if (!support.length) uncertainty.push('尚无已确认的直接材料关联；不能据此确认该条件。')
    if (def.key === 'return') uncertainty.push('材料中的还款安排不等于已确定到期日；需核实期限届满、是否变更及实际剩余本金。')
    if (def.key === 'agreement' || def.key === 'form') uncertainty.push('自然人身份与款项性质仍需核实；有转账不等于必然是借款。')
    const stance = conflict ? 'CONFLICT' as const : support.length ? 'MATERIAL_SUPPORTED' as const
      : facts.some(f => f.stance !== 'GAP') ? 'USER_STATED' as const : 'GAP' as const
    const identityGap = def.key === 'identity' && assessment.workspaceGaps.some(g => g.family === 'identity' && g.status !== 'SATISFIED')
    const conditional = coverage === 'RULE_AVAILABLE' && support.length > 0 && !conflict && !identityGap
    const conclusion = coverage === 'INSUFFICIENT_AUTHORITY'
      ? '当前没有覆盖这一核心条件的完整已核验规则，暂不能给出法律判断。'
      : conflict ? '相关事实存在明确争议，先核对双方说法与原始材料，暂不形成条件判断。'
        : identityGap ? '起诉状主体信息的条文已具备，但当前姓名或账号与主体对应仍有缺口；不能认为被告信息已准备齐全。'
        : !support.length ? '规则已具备，但当前没有可核对的直接材料支持，案件条件仍待补充。'
          : `如果能用完整原始材料核实“${def.requirement}”，则${def.consequence}。现有材料仅支持内容对应，未确认真实性或最终适用。`
    return { key: def.key, question: def.question, questionIds, ruleIds: selected.map(r => r.ruleId),
      applicationIds: relatedApps.map(a => a.applicationId), coverage, status: conditional ? 'CONDITIONAL' as const : 'UNKNOWN' as const,
      conditions: [{ requirement: def.requirement, ruleIds: selected.map(r => r.ruleId), stance, factIds,
        evidenceIds: unique(support.map(s => s.evidenceId)), gapIds: topicGaps.map(g => g.id), facts, support, uncertainty }], conclusion }
  })
  const basis = topics.filter(t => ['agreement', 'delivery', 'return'].includes(t.key))
  const canExplainBasis = basis.every(t => t.status === 'CONDITIONAL')
  const premise = isSimulated ? 'SIMULATED / DEMO ONLY：以下仅演示模拟材料的分析，不是真实证据。' : ''
  const summary = premise + (canExplainBasis
    ? `现有规范和已确认的材料内容，可形成要求返还${money}的条件性分析基础：须核实借款合意、实际交付、期限届满及未返还本金。当前不等于这些事实已获证明，也不保证请求获支持。`
    : `目前仍不能把要求返还${money}的基础说明完整；下列规则或直接材料条件尚不齐全。这不等于借款主张被否定。`)
    + (gaps.length ? `仍有${gaps.length}项当前缺口，正式处理前请逐项核对。` : '没有新增材料缺口不代表真实性或法院采信已确认。')
  const nextActions: LoanCoreAnalysis['nextActions'] = gaps.map(g => ({ instruction: `先补充或核对：${g.description}`,
    gapIds: [g.id], factIds: g.factIds, ruleIds: [] }))
  for (const t of topics.filter(t => t.status === 'UNKNOWN')) nextActions.push({
    instruction: t.coverage === 'INSUFFICIENT_AUTHORITY' ? `继续核对“${t.question}”对应规范，依据完整前保留判断。`
      : `对照原始材料核对“${t.conditions[0].requirement}”，补充直接关联后再分析。`,
    gapIds: t.conditions[0].gapIds, factIds: t.conditions[0].factIds, ruleIds: t.ruleIds })
  if (canExplainBasis) nextActions.push({ instruction: '按原始记录逐笔核对实际交付与已归还金额，并核对最初期限和后续有无变更；先明确剩余本金再提出返还请求。',
    gapIds: [], factIds: unique(basis.flatMap(t => t.conditions.flatMap(c => c.factIds))), ruleIds: unique(basis.flatMap(t => t.ruleIds)) })
  return loanCoreAnalysisSchema.parse({ simulated: isSimulated, summary, topics, gaps, nextActions })
}
