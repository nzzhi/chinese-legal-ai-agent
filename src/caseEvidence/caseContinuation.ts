import { createHash } from 'node:crypto'
import { z } from 'zod'
import { caseSchema } from '../case/caseSchema.js'
import { legalQuestionSchema } from '../legalQuestion/legalQuestionSchema.js'
import { legalRuleApplicationSchema } from '../legalRule/legalRuleSchema.js'
import { disputeAnalysisResultSchema } from '../classification/classificationSchema.js'
import { assessCaseEvidence, caseEvidenceInputSchema, isConfirmedLink } from './caseEvidence.js'

export const gapDispositionSchema = z.enum(['BLOCKING', 'DEGRADING', 'PLACEHOLDER_ALLOWED'])
export const capabilitySchema = z.enum(['ANALYSIS', 'RESEARCH', 'REPORT', 'FILING_DRAFT', 'EVIDENCE_ASSESSMENT'])
export type Capability = z.infer<typeof capabilitySchema>
export type GapDisposition = z.infer<typeof gapDispositionSchema>
export interface GapDecision {
  id: string
  disposition: GapDisposition
  title: string
  reason: string
  nextAction: string
  factIds: string[]
  questionIds: string[]
  impacts: Array<{ capability: Capability; scope: 'CAPABILITY' | 'DETERMINISTIC_CONCLUSION' }>
}
export interface DraftField {
  field: 'name' | 'identityNumber' | 'address'
  label: string
  value: string
  placeholder: boolean
}
export interface CaseContinuation {
  researchStatus: 'NOT_STARTED' | 'PARTIAL' | 'COMPLETE'
  workflowStatus: 'READY' | 'PARTIAL'
  filingReadiness: 'READY' | 'NEEDS_INFORMATION' | 'BLOCKED'
  evidenceReadiness: 'READY' | 'PARTIAL' | 'MISSING'
  gaps: GapDecision[]
  capabilities: Array<{ capability: Capability; status: 'AVAILABLE' | 'CONDITIONAL' | 'BLOCKED'; gapIds: string[] }>
  filingDraft: { available: boolean; fields: DraftField[]; notice: string }
}

const inputSchema = z.object({
  case: caseSchema,
  caseEvidence: caseEvidenceInputSchema.optional(),
  legalQuestions: z.array(legalQuestionSchema).default([]),
  ruleApplications: z.array(legalRuleApplicationSchema).default([]),
  disputeAnalysis: disputeAnalysisResultSchema.optional(),
  researchStatus: z.enum(['COMPLETE', 'INSUFFICIENT_AUTHORITY', 'INDETERMINATE', 'NO_LEGAL_QUESTIONS']).optional(),
  factsConfirmed: z.boolean().optional(),
})
const fieldLabels = { name: '对方完整姓名', identityNumber: '身份证号', address: '详细住址' }
const usable = (value: string) => value.trim() && !/未知|不详|未提供|待补|待核对|不完整|昵称|网名|【|】/.test(value)
  && !/^(无|对方|朋友|某人|不明)$/.test(value.trim())

/** Policy clearance alone never replaces the existing legal-conclusion publication checks. */
export const hasBlockingConclusionGap = (policy: CaseContinuation, questionId: string) => policy.gaps.some(g =>
  g.disposition === 'BLOCKING' && g.impacts.some(i => i.capability === 'ANALYSIS' && i.scope === 'DETERMINISTIC_CONCLUSION')
  && (!g.questionIds.length || g.questionIds.includes(questionId)))

/** Disposable policy projection. Never save it as a Fact, material review or research result. */
export function deriveCaseContinuation(input: unknown): CaseContinuation {
  const data = inputSchema.parse(input)
  const assessment = assessCaseEvidence({ ...data, evidence: data.caseEvidence })
  const facts = [...data.case.facts, ...data.case.disputedFacts]
  const stated = facts.filter(f => f.certainty !== 'UNKNOWN')
  const gaps: GapDecision[] = []
  const add = (key: string, disposition: GapDisposition, title: string, reason: string, nextAction: string,
    capabilities: Capability[], factIds: string[] = [], questionIds: string[] = [],
    scope: 'CAPABILITY' | 'DETERMINISTIC_CONCLUSION' = 'CAPABILITY') => {
    gaps.push({ id: `continuation-gap-${createHash('sha256').update(data.case.id + '\n' + key).digest('hex').slice(0, 24)}`,
      disposition, title, reason, nextAction, factIds, questionIds,
      impacts: capabilities.map(capability => ({ capability, scope })) })
  }
  for (const gap of assessment.evidenceGaps) add(gap.id, 'DEGRADING', gap.purpose,
    `${gap.reason} 待材料核验；仍可按用户陈述作条件性分析。`, gap.suggestedEvidence.concat(gap.alternatives).join('；'),
    ['ANALYSIS', 'REPORT', 'EVIDENCE_ASSESSMENT'], [gap.factId], gap.legalQuestionIds)

  // Read only explicit labels, or confirmed, linked material fields grounded in its content.
  // ponytail: no free-text identity inference; unlabeled names need explicit labeled information.
  const values = (field: string, labels: string) => {
    const fromFacts = stated.filter(f => f.category === 'PARTY' && f.certainty !== 'DISPUTED').flatMap(f =>
      [...f.content.matchAll(new RegExp(`(?:^|[\\n；;，,])(?:对方)?(?:${labels})[：:]\\s*([^\\n；;，,。]+)`, 'gu'))].map(m => m[1].trim()))
    const fromMaterials = assessment.items.filter(e => e.file?.confirmationStatus === 'CONFIRMED'
      && (e.type === 'OTHER' || e.type === 'PAYMENT_RECORD' && field === 'recipient')
      && assessment.links.some(l => l.evidenceId === e.id && isConfirmedLink(l)))
      .flatMap(e => e.file?.fields[field] && e.content?.includes(e.file.fields[field]) ? [e.file.fields[field].trim()] : [])
    return [...new Set([...fromFacts, ...fromMaterials].filter(usable))]
  }
  const nameValues = values('name', '姓名|名字').filter(value => value.length >= 2)
  const accountValues = values('account', '微信号|账号')
  const recipientValues = values('recipient', '收款方|转账对象')
  const identityValues = values('identityNumber', '身份证号|身份证号码')
  const addressValues = values('address', '详细住址|住址|住所|地址')
  const identified = nameValues.length === 1 || accountValues.length === 1 || recipientValues.length === 1
  if (!identified) add('counterparty', 'BLOCKING', '尚不能识别相对方',
    '现有信息没有可区分相对方的明确姓名、账号或转账对象；暂停起诉草稿，分析与缺口报告仍可继续。',
    '补充对方姓名、可区分的账号或转账对象，并说明它与本案的关系。', ['FILING_DRAFT'])
  const fieldValues = { name: nameValues, identityNumber: identityValues, address: addressValues }
  const fields: DraftField[] = (Object.keys(fieldLabels) as Array<keyof typeof fieldLabels>).map(field => {
    const found = fieldValues[field], placeholder = found.length !== 1
    if (placeholder && identified) add(field, 'PLACEHOLDER_ALLOWED', `${fieldLabels[field]}待补`,
      found.length > 1 ? '现有记录出现不同值，不选取其中一个作为已确认信息。' : '该信息尚未明确，可在准备草稿时保留显著占位，不影响分析和研究。',
      `补充并核对${fieldLabels[field]}；提交要求应另行核对。`, ['FILING_DRAFT'])
    return { field, label: fieldLabels[field], value: placeholder ? `【待补：${fieldLabels[field]}】` : found[0], placeholder }
  })
  const identityComplete = assessment.workspaceGaps.some(g => g.family === 'identity' && g.status === 'SATISFIED')
  if (identified && !identityComplete) add('identity-mapping', 'DEGRADING', '相对方与账号的对应关系待核对',
    '已知标识可用于准备草稿，但不能据此确认账号归属、实体责任或已符合起诉要求。',
    '把聊天对象、收款对象与对方身份对应核对；保留来源和完整上下文。', ['FILING_DRAFT', 'EVIDENCE_ASSESSMENT'])

  const noIou = stated.filter(f => /(?:没有|无|未写|未签|未出具).{0,4}借条/.test(f.content))
  if (noIou.length) add('no-iou', 'DEGRADING', '没有借条',
    '缺少借条不阻止分析或报告；借款合意、交付与履行仍需其他记录支持。',
    '保存借款约定、实际收款和还款沟通的完整记录。', ['ANALYSIS', 'REPORT', 'EVIDENCE_ASSESSMENT'], noIou.map(f => f.id))
  const reportedChats = assessment.items.filter(e => e.type === 'CHAT_RECORD' && e.source === 'USER_REPORTED')
  const chatFacts = stated.filter(f => /聊天|微信.{0,12}(?:说|表示|承诺|沟通)/.test(f.content))
  if (reportedChats.some(e => !assessment.links.some(l => isConfirmedLink(l) && e.relatedFactIds.includes(l.factId)
    && assessment.items.some(material => material.id === l.evidenceId && material.type === 'CHAT_RECORD'
      && material.source === 'PROVIDED_TEXT')))
    || chatFacts.some(f => !assessment.links.some(l => isConfirmedLink(l) && l.factId === f.id
      && assessment.items.some(material => material.id === l.evidenceId && material.type === 'CHAT_RECORD')))) {
    add('reported-chat', 'DEGRADING', '你提到有聊天，原始记录待核验',
    '用户陈述可继续作为分析前提；持有声明不等于原始聊天内容或真实性已核验。',
    '上传或登记原始完整会话，核对日期、双方账号与关键原文。', ['ANALYSIS', 'REPORT', 'EVIDENCE_ASSESSMENT'])
  }

  const substantive = stated.filter(f => ['PAYMENT', 'CONTRACT', 'SERVICE', 'EVENT', 'COMMUNICATION', 'TERMINATION'].includes(f.category)
    && !noIou.some(n => n.id === f.id) && !/^(?:用户(?:称|要求|希望))?.{0,3}(?:想咨询|要求退款|希望退款|不知道|不清楚)/.test(f.content))
  if (!substantive.length) add('core-facts', 'BLOCKING', '核心交易或事件经过尚未说明',
    '暂停依赖这些事实的确定性法律结论；仍可生成缺口报告和补充清单。',
    '说明发生了什么、双方做了什么、相关金额或对象，以及希望解决的问题。', ['ANALYSIS'], [],
    data.legalQuestions.map(q => q.id), 'DETERMINISTIC_CONCLUSION')
  for (const [index, question] of assessment.factQuestions.entries()) add(`unknown-${index}-${question.question}`, 'DEGRADING', question.question,
    '这部分信息尚未澄清，相关分析保留条件；不代表整个案件停止。',
    `补充说明：${question.question}`, ['ANALYSIS', 'REPORT'])
  const pending = assessment.items.filter(e => e.file?.confirmationStatus === 'PENDING')
  if (pending.length) add('pending-review', 'BLOCKING', '上传材料待内容核对',
    '暂不将这些未核对提取结果送入法律研究；已知陈述和用户报告仍可继续。',
    '核对提取原文与事实关联，确认或排除待核对材料。', ['RESEARCH'])
  if (data.factsConfirmed === false) add('fact-review', 'BLOCKING', '提取的事实陈述待用户核对',
    '启动法律研究前需确认提取内容符合当前陈述；仍可查看当前缺口报告。',
    '核对提取的事实，错误内容请先修正；确认不等于事实已证明。', ['RESEARCH'])
  const researchStatus = data.researchStatus === undefined ? 'NOT_STARTED' : data.researchStatus === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL'
  if (researchStatus !== 'COMPLETE') add('research', 'DEGRADING', researchStatus === 'NOT_STARTED' ? '法律研究尚未开始' : '部分法律依据仍待补充',
    '仅输出当前事实前提、已取得依据及待核对事项，不把研究不足当作主张被否定。',
    '继续整理现有材料；相关法律依据完整前保留条件性判断。', ['ANALYSIS', 'REPORT'])
  const capabilities = capabilitySchema.options.map(capability => {
    const relevant = gaps.filter(g => g.impacts.some(i => i.capability === capability))
    const blocked = relevant.some(g => g.disposition === 'BLOCKING'
      && g.impacts.some(i => i.capability === capability && i.scope === 'CAPABILITY'))
    return { capability, status: blocked ? 'BLOCKED' as const : relevant.length ? 'CONDITIONAL' as const : 'AVAILABLE' as const,
      gapIds: relevant.map(g => g.id) }
  })
  const filingBlocked = capabilities.find(c => c.capability === 'FILING_DRAFT')!.status === 'BLOCKED'
  const supported = assessment.factSupports.filter(f => f.status === 'SUPPORTED').length
  const hasMaterial = assessment.items.some(e => e.source === 'PROVIDED_TEXT' && e.content && e.file?.confirmationStatus !== 'REJECTED')
  return { researchStatus, workflowStatus: gaps.length ? 'PARTIAL' : 'READY',
    filingReadiness: filingBlocked ? 'BLOCKED' : fields.some(f => f.placeholder) || !identityComplete ? 'NEEDS_INFORMATION' : 'READY',
    evidenceReadiness: assessment.factSupports.length > 0 && supported === assessment.factSupports.length && identityComplete
      && !pending.length ? 'READY' : hasMaterial ? 'PARTIAL' : 'MISSING',
    gaps, capabilities, filingDraft: { available: !filingBlocked, fields: filingBlocked ? [] : fields,
      notice: '仅为准备草稿的字段；占位和内容登记不表示身份真实性、实体责任或已经可以提交起诉材料。' } }
}
