import { createHash } from 'node:crypto'
import { z } from 'zod'
import { caseSchema, type Case } from '../case/caseSchema.js'
import { legalQuestionSchema } from '../legalQuestion/legalQuestionSchema.js'
import { legalRuleApplicationSchema } from '../legalRule/legalRuleSchema.js'
import { disputeAnalysisResultSchema } from '../classification/classificationSchema.js'

const text = z.string().trim().min(1).max(20_000)
const ids = z.array(text).max(500).refine(values => new Set(values).size === values.length, 'Duplicate IDs')
export const caseEvidenceTypeSchema = z.enum(['CONTRACT', 'PAYMENT_RECORD', 'CHAT_RECORD', 'AUDIO',
  'VIDEO', 'IMAGE', 'RECEIPT', 'INVOICE', 'NOTICE', 'PLATFORM_RECORD', 'OTHER'])
export const evidenceFileSchema = z.strictObject({
  caseId: text, filename: z.string().min(1).max(255), mimeType: text,
  fileSize: z.number().int().positive().max(10 * 1024 * 1024),
  sourceType: z.literal('USER_UPLOAD'), uploadedAt: z.string().datetime(),
  parseStatus: z.enum(['UPLOADED', 'PARSED', 'NEEDS_REVIEW']),
  confirmationStatus: z.enum(['PENDING', 'CONFIRMED', 'REJECTED']),
  hash: z.string().regex(/^[a-f0-9]{64}$/), summary: text.optional(),
  extractionMethod: z.enum(['TEXT', 'PDF_TEXT', 'MANUAL_TRANSCRIPTION', 'LOCAL_OCR']).optional(),
  fields: z.record(z.string(), z.string().max(2000)), reviewReasons: z.array(text),
  contextComplete: z.boolean(), confirmedAt: z.string().datetime().optional(),
})
export const caseEvidenceSchema = z.strictObject({
  id: text, type: caseEvidenceTypeSchema, title: text.optional(), description: text.optional(),
  source: z.enum(['USER_REPORTED', 'PROVIDED_TEXT', 'FILE_REFERENCE']),
  sourceReference: text.optional(), content: text.optional(), collectedAt: z.string().datetime().optional(),
  relatedFactIds: ids, file: evidenceFileSchema.optional(),
}).superRefine((item, ctx) => {
  if (item.source === 'PROVIDED_TEXT' && !item.content) ctx.addIssue({ code: 'custom', message: 'Provided text requires content' })
  if (item.source === 'FILE_REFERENCE' && !item.sourceReference) ctx.addIssue({ code: 'custom', message: 'File reference requires a locator' })
  if (item.file && (!item.sourceReference || item.source === 'USER_REPORTED'
    || item.file.parseStatus !== 'UPLOADED' && !item.content && item.file.parseStatus !== 'NEEDS_REVIEW'
    || item.file.confirmationStatus === 'CONFIRMED' && (!item.content || !item.file.confirmedAt))) {
    ctx.addIssue({ code: 'custom', message: 'Uploaded file state contradicts its content or confirmation record' })
  }
})
export const caseEvidenceLinkSchema = z.strictObject({
  evidenceId: text, factId: text, support: z.enum(['SUPPORTED', 'PARTIAL']),
  quote: text, purpose: text,
  relationType: z.enum(['SUPPORTS', 'PARTIALLY_SUPPORTS']).optional(),
  status: z.enum(['SUGGESTED', 'CONFIRMED', 'CANCELLED']).optional(),
  confirmedByUser: z.boolean().optional(), createdAt: z.string().datetime().optional(),
  review: z.strictObject({ method: z.literal('HUMAN_CONTENT_REVIEW'), reviewerId: text,
    reviewedAt: z.string().datetime(), reason: text }).optional(),
}).superRefine((link, ctx) => {
  if ((link.status === undefined || link.status === 'CONFIRMED') && !link.review
    || link.status === undefined && link.confirmedByUser === false
    || link.status === 'CONFIRMED' && link.confirmedByUser !== true
    || link.status !== undefined && !link.createdAt) ctx.addIssue({ code: 'custom', message: 'Confirmed support requires human review; workspace links require timestamps' })
})
export const caseEvidenceInputSchema = z.strictObject({
  items: z.array(caseEvidenceSchema).max(100), links: z.array(caseEvidenceLinkSchema).max(500),
})
export type CaseEvidence = z.infer<typeof caseEvidenceSchema>
export type CaseEvidenceLink = z.infer<typeof caseEvidenceLinkSchema>
export type CaseEvidenceInput = z.infer<typeof caseEvidenceInputSchema>
export type CaseFactSupportStatus = 'SUPPORTED' | 'PARTIAL' | 'UNSUPPORTED' | 'UNKNOWN'
export interface CaseFactSupport {
  factId: string; status: CaseFactSupportStatus; evidenceIds: string[]; reason: string
}
export interface EvidenceGap {
  id: string; factId: string; importance: 'HIGH' | 'MEDIUM'; reason: string; purpose: string
  suggestedEvidence: string[]; alternatives: string[]; evidenceIds: string[]
  legalQuestionIds: string[]; applicationIds: string[]; disputedFactIds: string[]
  whyItMatters: string
  status?: 'MISSING' | 'PARTIAL' | 'SATISFIED'
}
export interface WorkspaceGap {
  id: string; family: 'payment' | 'chat' | 'identity'; title: string
  status: 'MISSING' | 'PARTIAL' | 'SATISFIED'; evidenceIds: string[]; missingFields: string[]
}
export interface CaseEvidenceAssessment extends CaseEvidenceInput {
  factSupports: CaseFactSupport[]
  evidenceGaps: EvidenceGap[]
  evidenceGapHistory: EvidenceGap[]
  applicationEvidence: Array<{ applicationId: string; facts: CaseFactSupport[]; evidenceGapIds: string[] }>
  factQuestions: Case['unknownFacts']
  workspaceGaps: WorkspaceGap[]
}

export const isConfirmedLink = (link: CaseEvidenceLink) => link.status === undefined || link.status === 'CONFIRMED'
export const isPaymentReceived = (result: string | undefined) => /^(转账成功|已到账|到账|成功|已收款)$/.test(result ?? '')
export function evidenceStage(item: CaseEvidence, allItems: CaseEvidence[] = []): string {
  if (item.source === 'USER_REPORTED') {
    const imported = allItems.filter(e => e.file && e.type === item.type && e.file.confirmationStatus !== 'REJECTED'
      && e.relatedFactIds.some(id => item.relatedFactIds.includes(id)))
    const confirmed = imported.find(e => e.file?.confirmationStatus === 'CONFIRMED')
    if (confirmed || imported.length) return evidenceStage(confirmed ?? imported[0])
  }
  if (!item.file) return item.source === 'USER_REPORTED' ? '你提到持有' : item.source === 'FILE_REFERENCE' ? '已登记文件，内容未读取' : '已提供文字'
  if (item.file.confirmationStatus === 'REJECTED') return '用户已标记无关或提取错误'
  if (item.file.confirmationStatus === 'CONFIRMED') return '已导入并确认关键信息'
  return item.file.parseStatus === 'UPLOADED' ? '已上传，内容尚未读取完成'
    : item.file.parseStatus === 'NEEDS_REVIEW' ? '已上传，需要用户核对' : '已解析，待用户确认'
}

/** Completeness is a deterministic checklist plus explicit user review, never authenticity. */
export function workspaceGaps(caseId: string, evidence: CaseEvidenceInput): WorkspaceGap[] {
  const linked = evidence.items.filter(e => e.file?.confirmationStatus === 'CONFIRMED'
    && evidence.links.some(l => l.evidenceId === e.id && isConfirmedLink(l)))
  return (['payment', 'chat', 'identity'] as const).map(family => {
    const items = linked.filter(e => family === 'payment' ? e.type === 'PAYMENT_RECORD'
      : family === 'chat' ? e.type === 'CHAT_RECORD' : !!(e.file?.fields.account || e.file?.fields.recipient || e.file?.fields.participants))
    const requirements = family === 'payment' ? ['amount', 'time', 'transactionId', 'payer', 'recipient', 'result']
      : family === 'chat' ? ['participants', 'time', 'keyQuotes'] : ['name', 'account', 'mapping', 'source']
    const complete = items.find(e => requirements.every(k => !!e.file?.fields[k]) && e.file?.contextComplete
      && (family !== 'payment' || isPaymentReceived(e.file.fields.result))
      && (family !== 'identity' || e.file.extractionMethod === 'MANUAL_TRANSCRIPTION'))
    const best = complete ?? [...items].sort((a, b) => requirements.filter(k => b.file?.fields[k]).length - requirements.filter(k => a.file?.fields[k]).length)[0]
    const missingFields = requirements.filter(k => !best?.file?.fields[k])
    if (best && !best.file?.contextComplete) missingFields.push('完整上下文尚未确认')
    if (family === 'identity' && best && best.file?.extractionMethod !== 'MANUAL_TRANSCRIPTION') missingFields.push('身份与账号对应关系需人工核对登记')
    if (family === 'payment' && best && !isPaymentReceived(best.file!.fields.result)) missingFields.push('未记录成功到账状态')
    return { id: `workspace-gap-${createHash('sha256').update(caseId + family).digest('hex').slice(0, 24)}`, family,
      title: family === 'payment' ? '完整微信转账记录' : family === 'chat' ? '完整微信聊天记录' : '对方身份与账号对应',
      status: complete ? 'SATISFIED' : items.length ? 'PARTIAL' : 'MISSING', evidenceIds: items.map(e => e.id), missingFields }
  })
}

// Category selects material suggestions, never infers that a particular document proves a fact.
const materials: Record<string, [string[], string[]]> = {
  PAYMENT: [['原始支付或银行转账记录（含金额、时间、双方账户）'], ['收款确认、收据或对应订单记录']],
  CONTRACT: [['完整合同、订单或付款前后的完整约定聊天'], ['当时宣传页、套餐截图或平台订单详情']],
  SERVICE: [['履行或使用记录、双方关于履行情况的完整沟通'], ['预约记录、平台服务记录或现场记录']],
  COMMUNICATION: [['完整聊天、短信、邮件或原始录音及上下文'], ['平台客服记录、对方确认或对应通知']],
  PARTY: [['合同、订单或账户中可核对的主体信息'], ['对方确认身份的沟通或平台账户记录']],
}

/** Support is a recorded human content assessment, not authenticity or judicial admissibility. */
export function assessCaseEvidence(input: { case: unknown; legalQuestions: unknown; ruleApplications: unknown;
  evidence?: unknown; disputeAnalysis?: unknown }): CaseEvidenceAssessment {
  const caseData = caseSchema.parse(input.case)
  const questions = z.array(legalQuestionSchema).parse(input.legalQuestions)
  const applications = z.array(legalRuleApplicationSchema).parse(input.ruleApplications)
  const evidence = caseEvidenceInputSchema.parse(input.evidence ?? { items: [], links: [] })
  const disputes = input.disputeAnalysis === undefined ? []
    : disputeAnalysisResultSchema.parse(input.disputeAnalysis).disputedFacts.filter(d => d.opposingPosition)
  const facts = [...caseData.facts, ...caseData.disputedFacts]
  const factById = new Map(facts.map(f => [f.id, f]))
  const itemById = new Map(evidence.items.map(e => [e.id, e]))
  if (itemById.size !== evidence.items.length) throw new Error('Duplicate case evidence IDs')
  if (new Set(questions.map(q => q.id)).size !== questions.length
    || new Set(applications.map(a => a.applicationId)).size !== applications.length) throw new Error('Duplicate question/application IDs')
  for (const q of questions) if (q.relatedFactIds.some(id => !factById.has(id))) throw new Error('Unknown question fact ID')
  for (const app of applications) {
    const q = questions.find(q => q.id === app.legalQuestionId)
    if (!q || app.relatedFactIds.some(id => !factById.has(id) || !q.relatedFactIds.includes(id))) {
      throw new Error('Application evidence references contradict question facts')
    }
  }
  for (const item of evidence.items) if (item.relatedFactIds.some(id => !factById.has(id))) throw new Error('Unknown evidence fact ID')
  for (const item of evidence.items) if (item.file && item.file.caseId !== caseData.id) throw new Error('Cross-case evidence')
  for (const dispute of disputes) if (dispute.relatedFactIds.some(id => !factById.has(id))) throw new Error('Unknown disputed fact reference')
  const pairs = new Set<string>()
  for (const link of evidence.links) {
    const item = itemById.get(link.evidenceId), fact = factById.get(link.factId)
    const pair = JSON.stringify([link.evidenceId, link.factId])
    if (pairs.has(pair)) throw new Error('Duplicate evidence/fact link')
    pairs.add(pair)
    if (!item || !fact || !item.relatedFactIds.includes(link.factId)) throw new Error('Unknown or unlisted evidence/fact link')
    if (item.source !== 'PROVIDED_TEXT' || !item.content?.includes(link.quote)) throw new Error('Support requires a reviewed exact quote in provided material text')
    if (item.file && isConfirmedLink(link) && item.file.confirmationStatus !== 'CONFIRMED') throw new Error('File support requires user confirmation')
    if (item.type === 'PAYMENT_RECORD' && fact.category !== 'PAYMENT') throw new Error('Payment record cannot alone establish contract terms or other facts')
  }
  const factSupports: CaseFactSupport[] = facts.map(fact => {
    const linked = evidence.links.filter(link => link.factId === fact.id && isConfirmedLink(link))
    const declared = evidence.items.filter(e => e.relatedFactIds.includes(fact.id))
    const disputed = fact.certainty === 'DISPUTED' || disputes.some(d => d.relatedFactIds.includes(fact.id))
    const status: CaseFactSupportStatus = fact.certainty === 'UNKNOWN' ? 'UNKNOWN'
      : linked.some(link => link.support === 'SUPPORTED') && !disputed ? 'SUPPORTED'
        : linked.length ? 'PARTIAL' : declared.length ? 'UNKNOWN' : 'UNSUPPORTED'
    return { factId: fact.id, status, evidenceIds: declared.map(e => e.id),
      reason: fact.certainty === 'UNKNOWN' ? '尚未明确发生了什么，应先澄清事实。'
        : status === 'SUPPORTED' ? '已有明确关联及人工内容审查的材料片段；未鉴定真实性，也不代表法院采信。'
          : status === 'PARTIAL' ? '材料只提供部分支持，或该事实仍有争议；需结合完整上下文核对。'
            : status === 'UNKNOWN' ? '已登记材料，但未提供可核对内容或针对该事实的内容审查。'
              : '你已说明这一事实，但目前未登记可支持该事实的案件材料。' }
  })
  const evidenceGapHistory: EvidenceGap[] = []
  for (const support of factSupports) {
    const fact = factById.get(support.factId)!
    const qs = questions.filter(q => q.relatedFactIds.includes(fact.id))
    const apps = applications.filter(a => a.relatedFactIds.includes(fact.id))
    const disputeIds = disputes.filter(d => d.relatedFactIds.includes(fact.id)).map(d => d.id)
      .concat(caseData.disputedFacts.filter(f => f.id === fact.id).map(f => f.id))
    const disputed = disputeIds.length > 0
    if (fact.certainty === 'UNKNOWN'
      || !(qs.some(q => q.importance === 'HIGH') || apps.length || disputed)) continue
    const [suggestedEvidence, alternatives] = materials[fact.category]
      ?? [['与该事实直接对应的原始记录及完整上下文'], ['对方确认、同期沟通或第三方平台记录']]
    evidenceGapHistory.push({ id: `case-gap-${createHash('sha256').update(caseData.id + '\n' + fact.id).digest('hex').slice(0, 24)}`,
      factId: fact.id, status: support.status === 'SUPPORTED' ? 'SATISFIED' : support.status === 'PARTIAL' ? 'PARTIAL' : 'MISSING', importance: qs.some(q => q.importance === 'HIGH') ? 'HIGH' : 'MEDIUM',
      reason: support.reason, purpose: `用于核对并支持你所陈述的事实：${fact.content}`,
      whyItMatters: qs.some(q => q.importance === 'HIGH')
        ? `核心法律问题依赖此事实：${qs.filter(q => q.importance === 'HIGH').map(q => q.question).join('；')}`
        : apps.length ? '现有规则适用记录实际引用了此事实；材料不足会限制该记录的事实基础。'
          : '双方对该事实有争议，需要核对各自说法的材料基础。',
      suggestedEvidence, alternatives, evidenceIds: support.evidenceIds,
      legalQuestionIds: qs.map(q => q.id), applicationIds: apps.map(a => a.applicationId),
      disputedFactIds: [...new Set(disputeIds)] })
  }
  const evidenceGaps = evidenceGapHistory.filter(g => g.status !== 'SATISFIED')
  return { ...evidence, factSupports, evidenceGaps, evidenceGapHistory, workspaceGaps: workspaceGaps(caseData.id, evidence),
    applicationEvidence: applications.map(a => ({ applicationId: a.applicationId,
      facts: factSupports.filter(f => a.relatedFactIds.includes(f.factId)),
      evidenceGapIds: evidenceGaps.filter(g => a.relatedFactIds.includes(g.factId)).map(g => g.id) })),
    factQuestions: [...caseData.unknownFacts, ...facts.filter(f => f.certainty === 'UNKNOWN')
      .map(f => ({ question: `请澄清：${f.content}`, importance: 'MEDIUM' as const }))] }
}

export function caseEvidenceUserLines(assessment: CaseEvidenceAssessment, caseData: Case): string[] {
  const facts = [...caseData.facts, ...caseData.disputedFacts]
  const labels = { SUPPORTED: '已有材料支持（按内容审查记录）', PARTIAL: '部分支持', UNSUPPORTED: '缺少材料支持', UNKNOWN: '尚无法评估' }
  return ['当前已有证据', ...(assessment.items.length ? assessment.items.flatMap(item => [
    `${item.title ?? item.description ?? item.type}：${item.file ? evidenceStage(item) : item.source === 'USER_REPORTED' ? '用户称持有，材料未核对' : item.source === 'FILE_REFERENCE' ? '已登记文件位置，内容未读取' : '已提供文字内容，真实性未鉴定'}`,
    ...assessment.links.filter(l => l.evidenceId === item.id && isConfirmedLink(l)).map(l => `可支持的范围：${l.purpose}；内容片段：“${l.quote}”；${l.support === 'PARTIAL' ? '部分支持' : '按人工内容审查记录提供支持'}`),
  ]) : ['目前没有登记案件材料；用户陈述本身不等于已有材料支持。']),
  '关键事实的证据状态', ...assessment.factSupports.map(f => `${facts.find(fact => fact.id === f.factId)!.content}：${labels[f.status]}`),
  '目前最需要补充', ...assessment.evidenceGaps.flatMap(g => [
    `${facts.find(f => f.id === g.factId)!.content}：${g.reason}`, `为什么重要：${g.whyItMatters}`, g.purpose,
    `如果仍能取得，可优先寻找：${g.suggestedEvidence.join('；')}。`,
    `若暂时无法取得，可尝试寻找替代材料：${g.alternatives.join('；')}；仍需核对其具体证明范围。`,
  ]), '待澄清的事实信息', ...assessment.factQuestions.map(q => q.question),
  '材料内容支持不等于事实已查明、真实性鉴定或法院采信；历史待澄清信息需确认是事实未说明还是材料未提供。']
}
