import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { caseSchema } from '../case/caseSchema.js'
import { caseEvidenceInputSchema } from '../caseEvidence/caseEvidence.js'
import { legalQuestionSchema } from '../legalQuestion/legalQuestionSchema.js'
import { candidateLegalSourceSchema, legalRetrievalResultSchema } from '../retrieval/retrievalSchema.js'
import { legalSearchQuerySchema } from '../legalQuery/legalQuerySchema.js'
import { sourceVerificationResultSchema } from '../verification/sourceVerificationSchema.js'
import { analysisDraftSchema, checkedInput, validateConditionalAnalysis, conditionalQuestionBlockSchema } from '../legalRule/conditionalAnalysis.js'
import { normativeIRDraftSchema, validateNormativeIR, validateEntailment, validateIRApplication,
  renderNormativeRule, type NormativeQuestionAnalysis } from '../legalRule/normativeRule.js'
import { buildReport } from './reportBuilder.js'
import type { ReportBlock } from './reportModel.js'
import type { PrintableReport } from './userCaseReport.js'

export const questionDiagnosticSchema = z.strictObject({ legalQuestionId: z.string(),
  status: z.enum(['BLOCKED', 'NOT_RUN']), stage: z.string().max(100), reason: z.string().max(6000) })
const sourceSchema = z.object({ caseSnapshotId: z.string(), case: caseSchema, caseEvidence: caseEvidenceInputSchema,
  legalQuestions: z.array(legalQuestionSchema), candidateVerifications: z.array(z.object({ caseSnapshotId: z.string(),
    query: legalSearchQuerySchema, retrieval: legalRetrievalResultSchema, candidate: candidateLegalSourceSchema, result: sourceVerificationResultSchema })),
  conditionalAnalysis: z.object({ caseSnapshotId: z.string(), questions: z.array(z.unknown()).max(24),
    blocked: z.array(conditionalQuestionBlockSchema).max(24).optional() }),
  questionDiagnostics: z.array(questionDiagnosticSchema).max(24).optional() })
const tracedRefs = normativeIRDraftSchema.shape.propositions.element.shape.support.element.passthrough().array()
const nodeSchema = normativeIRDraftSchema.shape.propositions.element.extend({ support: tracedRefs }).passthrough()
const selectionSchema = analysisDraftSchema.shape.authorities.element.extend({ requiredConditions:
  analysisDraftSchema.shape.authorities.element.shape.requiredConditions.element.extend({ support: tracedRefs }).passthrough().array() }).passthrough()
const expandedRuleSchema = z.object({ ruleId: z.string(), ruleKind: normativeIRDraftSchema.shape.rules.element.shape.ruleKind,
  relationship: normativeIRDraftSchema.shape.rules.element.shape.relationship.extend({ support: tracedRefs }).passthrough(), scope: z.array(nodeSchema),
  operator: z.enum(['ALL', 'ANY']), branches: z.array(z.object({ branchId: z.string(),
    conditionGroups: z.array(z.object({ groupId: z.string(), operator: z.enum(['ALL', 'ANY']), conditions: z.array(nodeSchema), support: nodeSchema.shape.support })),
    consequences: z.array(nodeSchema), exceptions: z.array(nodeSchema), limitations: z.array(nodeSchema), support: nodeSchema.shape.support })),
  assessmentFactors: z.array(nodeSchema), limitations: z.array(nodeSchema), authorityIds: z.array(z.string()) })
const savedQuestionSchema = z.object({ caseSnapshotId: z.string(), legalQuestionId: z.string(),
  analysisStatus: z.literal('NO_VERIFIED_AUTHORITY').optional(),
  authoritySelections: z.array(selectionSchema),
  normativeIR: z.object({ version: z.literal('NORMATIVE_IR_V1'), propositions: z.array(nodeSchema), rules: z.array(expandedRuleSchema) }),
  entailment: z.unknown(), rules: z.array(z.unknown()), applications: z.array(z.object({ conditionAssessments: z.array(z.object({
    conditionId: z.string(), factIds: z.array(z.string()), gaps: z.array(z.object({ text: z.string() })), reasoning: z.string() })) })) })
// JSON comparison retains every saved field while ignoring in-memory undefined properties.
const same = (a: unknown, b: unknown) => {
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))) throw new Error('Saved conditional research does not match validated projection')
}

/** Re-check saved outputs using the production validators. No model, network or new legal reasoning. */
export function validatedConditionalResearch(input: unknown) {
  const optional = z.object({ conditionalAnalysis: z.unknown().optional() }).parse(input)
  if (optional.conditionalAnalysis === undefined) return undefined
  const data = sourceSchema.parse(input)
  checkedInput(data)
  if (data.conditionalAnalysis.caseSnapshotId !== data.caseSnapshotId) throw new Error('STALE_FACT_REFERENCES: saved analysis snapshot')
  const accepted = new Map<string, NormativeQuestionAnalysis>()
  const unavailable = new Set<string>()
  for (const raw of data.conditionalAnalysis.questions) {
    const saved = savedQuestionSchema.parse(raw)
    const question = data.legalQuestions.find(q => q.id === saved.legalQuestionId)
    if (!question || accepted.has(question.id) || unavailable.has(question.id) || saved.caseSnapshotId !== data.caseSnapshotId) throw new Error('Invalid saved analysis question')
    const authorities = data.candidateVerifications.filter(v => v.query.legalQuestionId === question.id && v.query.sourcePurpose !== 'REFERENCE'
      && v.result.status === 'VERIFIED' && v.result.verifiedSource?.authority).map(v => ({ authorityId: v.result.providerSourceId!,
      verificationId: v.result.verificationId, article: v.result.verifiedSource!.authority!.article.articleNumber, text: v.result.verifiedSource!.content }))
    if (!authorities.length) {
      same(raw, { caseSnapshotId: data.caseSnapshotId, legalQuestionId: question.id, analysisStatus: 'NO_VERIFIED_AUTHORITY',
        authoritySelections: [], normativeIR: { version: 'NORMATIVE_IR_V1', propositions: [], rules: [] }, entailment: { checks: [] }, rules: [], applications: [] })
      unavailable.add(question.id)
      continue
    }
    if (saved.analysisStatus !== undefined) throw new Error('Invalid saved analysis question status')
    const decisions = analysisDraftSchema.shape.authorities.parse(saved.authoritySelections.map(a => ({ authorityId: a.authorityId,
      status: a.status, role: a.role, selectedForRule: a.selectedForRule, reason: a.reason,
      requiredConditions: a.requiredConditions.map(c => ({ text: c.text, kind: c.kind, factIds: c.factIds, missingReason: c.missingReason,
        support: c.support.map(({ authorityId, quote }) => ({ authorityId, quote })) })) })))
    const selections = validateConditionalAnalysis(data, question, { authorities: decisions, rules: [], applications: [] }).authoritySelections
    same((raw as Record<string, unknown>).authoritySelections, selections)
    const selected = authorities.filter(a => selections.some(s => s.authorityId === a.authorityId && s.selectedForRule))
    const prefix = createHash('sha256').update(JSON.stringify(`${data.caseSnapshotId}/${question.id}`)).digest('hex').slice(0, 18)
    const local = (value: string, start: string) => {
      if (!value.startsWith(start)) throw new Error('Invalid saved IR identity')
      return value.slice(start.length)
    }
    const nodeId = (value: string) => local(value, `node-${prefix}-`)
    const ruleId = (value: string) => local(value, `ir-rule-${prefix}-`)
    const refs = (values: z.infer<typeof nodeSchema>['support']) => values.map(({ authorityId, quote }) => ({ authorityId, quote }))
    const draft = { propositions: saved.normativeIR.propositions.map(n => ({ nodeId: nodeId(n.nodeId), kind: n.kind, text: n.text, support: refs(n.support) })),
      rules: saved.normativeIR.rules.map(r => ({ ruleId: ruleId(r.ruleId), ruleKind: r.ruleKind,
        relationship: { type: r.relationship.type, relatedRuleId: r.relationship.relatedRuleId ? ruleId(r.relationship.relatedRuleId) : undefined, support: refs(r.relationship.support) },
        scopeIds: r.scope.map(n => nodeId(n.nodeId)), operator: r.operator,
        branches: r.branches.map(b => { const id = local(b.branchId, `branch-${prefix}-${ruleId(r.ruleId)}-`); return {
          branchId: id, conditionGroups: b.conditionGroups.map(g => ({ groupId: local(g.groupId, `group-${prefix}-${ruleId(r.ruleId)}-${id}-`),
            operator: g.operator, propositionIds: g.conditions.map(n => nodeId(n.nodeId)), support: refs(g.support) })),
          consequenceIds: b.consequences.map(n => nodeId(n.nodeId)), exceptionIds: b.exceptions.map(n => nodeId(n.nodeId)),
          limitationIds: b.limitations.map(n => nodeId(n.nodeId)), support: refs(b.support) } }),
        assessmentFactorIds: r.assessmentFactors.map(n => nodeId(n.nodeId)), limitationIds: r.limitations.map(n => nodeId(n.nodeId)), authorityIds: r.authorityIds })) }
    const ir = validateNormativeIR(draft, selected, `${data.caseSnapshotId}/${question.id}`)
    same((raw as Record<string, unknown>).normativeIR, ir)
    const entailment = validateEntailment(ir, saved.entailment)
    const observations = new Map<string, { nodeId: string; factIds: string[]; gaps: string[]; observation: string }>()
    for (const app of saved.applications) for (const c of app.conditionAssessments) {
      // bindConditionAssessment already inserts these deterministic gaps; it deduplicates them on replay.
      const observation = { nodeId: c.conditionId, factIds: c.factIds, gaps: c.gaps.map(g => g.text), observation: c.reasoning }
      if (observations.has(c.conditionId)) same(observations.get(c.conditionId), observation)
      observations.set(c.conditionId, observation)
    }
    const applications = validateIRApplication(data, question, ir, { observations: [...observations.values()] }, selected)
    same((raw as Record<string, unknown>).applications, applications)
    const rules = ir.rules.map(r => ({ ruleId: r.ruleId, legalQuestionId: question.id, caseSnapshotId: data.caseSnapshotId,
      proposition: renderNormativeRule(r), ir: r, authorityIds: r.authorityIds,
      conditions: [...r.scope, ...r.branches.flatMap(b => b.conditionGroups.flatMap(g => g.conditions))].map(n => ({ conditionId: n.nodeId, text: n.text, support: n.support })),
      consequence: { text: r.branches.map(b => b.consequences.map(n => n.text).join('；')).join(' / 替代路径：'), support: r.branches.flatMap(b => b.consequences.flatMap(n => n.support)) },
      limitations: [...r.limitations, ...r.branches.flatMap(b => [...b.exceptions, ...b.limitations])].map(n => ({ text: n.text, support: n.support })) }))
    same(saved.rules, rules)
    accepted.set(question.id, { caseSnapshotId: data.caseSnapshotId, legalQuestionId: question.id, authoritySelections: selections, normativeIR: ir, entailment, rules, applications })
  }
  const blocked = data.conditionalAnalysis.blocked ?? []
  if (new Set(blocked.map(d => d.legalQuestionId)).size !== blocked.length || blocked.some(d => accepted.has(d.legalQuestionId)
    || unavailable.has(d.legalQuestionId) || !data.legalQuestions.some(q => q.id === d.legalQuestionId)
    || data.questionDiagnostics?.some(previous => previous.legalQuestionId === d.legalQuestionId))) throw new Error('Invalid blocked conditional analysis coverage')
  const diagnostics = [...data.questionDiagnostics ?? [], ...blocked, ...[...unavailable].filter(id => !data.questionDiagnostics?.some(d => d.legalQuestionId === id))
    .map(legalQuestionId => questionDiagnosticSchema.parse({ legalQuestionId, status: 'BLOCKED', stage: 'SOURCE_VERIFICATION', reason: 'NO_VERIFIED_AUTHORITY：本问题尚无已核验的规范来源。' }))]
  if (new Set(diagnostics.map(d => d.legalQuestionId)).size !== diagnostics.length || diagnostics.some(d => accepted.has(d.legalQuestionId)
    || !data.legalQuestions.some(q => q.id === d.legalQuestionId))) throw new Error('Invalid question diagnostic coverage')
  const usedVerifications = new Set([...accepted.values()].flatMap(a => a.normativeIR.rules.flatMap(r => r.authorityRefs.map(ref => ref.verificationId))))
  const sources = data.candidateVerifications.filter(v => usedVerifications.has(v.result.verificationId)).map(v => ({
    verificationId: v.result.verificationId, title: v.result.verifiedSource!.title, article: v.result.verifiedSource!.authority!.article.articleNumber,
    sourceUrl: v.result.verifiedSource!.sourceUrl, fetchedAt: v.result.verifiedSource!.authority!.document.fetchedAt,
    legalQuestionId: v.query.legalQuestionId,
  }))
  return { caseSnapshotId: data.caseSnapshotId, questionCount: data.legalQuestions.length, acceptedCount: accepted.size, sources,
    questions: data.legalQuestions.map(q => ({ question: q, analysis: accepted.get(q.id), diagnostic: diagnostics.find(d => d.legalQuestionId === q.id),
      status: accepted.has(q.id) ? 'CONDITIONAL' as const : diagnostics.find(d => d.legalQuestionId === q.id)?.status ?? 'NOT_RUN' as const })) }
}
export type ConditionalResearchReport = NonNullable<ReturnType<typeof validatedConditionalResearch>>
const p = (text: string): ReportBlock => ({ kind: 'paragraph', text })
const h = (text: string): ReportBlock => ({ kind: 'heading', text })
const labels = { SUPPORTED: '有支持线索，仍需核验', PARTIALLY_SUPPORTED: '部分支持', USER_CLAIM_ONLY: '仅有用户陈述', UNKNOWN: '尚待核对', CONTRADICTED: '存在争议或反向线索' }
export const conditionalStatusText = { CONDITIONAL: '已形成条件分析，事实和材料仍须核验', BLOCKED: '研究受阻，尚不能判断', NOT_RUN: '尚未完成该问题研究' }

export function conditionalReportSections(report: ConditionalResearchReport, input: unknown, internal: boolean): PrintableReport['sections'] {
  const data = sourceSchema.parse(input)
  const sources = data.candidateVerifications.map(v => v.result.verifiedSource).filter(s => !!s)
  const readable = (text: string) => internal ? text : text.replace(/\b(?:fact|question)-[\w-]+\b/g, id => {
    const fact = data.case.facts.concat(data.case.disputedFacts).find(f => f.id === id)
    return fact ? `“${fact.content}”` : data.legalQuestions.find(q => q.id === id)?.question ?? '相关记录'
  }).replace(/USER_CLAIM/g, '用户陈述').replace(/CONFIRMED/g, '用户核对').replace(/UNKNOWN/g, '待核对')
  return report.questions.map(({ question, analysis, diagnostic, status }) => ({ title: internal ? `${question.id} · ${question.question}` : question.question,
    blocks: [p(conditionalStatusText[status]), ...(!analysis ? [p(internal && diagnostic ? `${diagnostic.stage}：${diagnostic.reason}`
      : '当前依据或研究步骤尚未齐备，不能据此支持或否定你的诉求。')] : analysis.rules.flatMap(r => {
      const app = analysis.applications.find(a => a.ruleId === r.ruleId)!
      const citations = [...new Map(r.ir.authorityRefs.map(ref => [internal ? `${ref.verificationId}:${ref.startOffset}:${ref.endOffset}` : ref.verificationId, ref])).values()]
      return [h(internal ? r.ruleId : '适用规则与条件'), p(r.proposition), p(app.overallAssessment.reasoning),
        ...app.branchAssessments.flatMap((b, i) => [h(`路径 ${i + 1}`), p(b.legalReasoning), ...(internal ? [p(`${b.branchId} · ${labels[b.status]}`)] : [])]),
        ...app.conditionAssessments.flatMap(c => [h(c.condition), p(`当前情况：${labels[c.status]}。${readable(c.reasoning)}`),
          ...c.factStances.map(f => p(`${internal ? `${f.factId} · ${f.certainty} · ` : '你提供的陈述：'}${f.content}`)),
          ...c.materialStates.map(m => p(`${data.caseEvidence.items.find(e => e.id === m.evidenceId)?.title ?? '关联材料'}：${m.parsed ? '已有原文' : '尚无原文'}；${m.linked ? '用户核对内容关联' : '关联待核对'}；${m.authenticity === 'SIMULATED' ? '模拟材料，仅用于演示' : '真实性未核验'}`)),
          ...c.gaps.map(g => p(`还需核对：${readable(g.text)}`))]), ...app.legalBasisGaps.map(g => p(readable(g))), h('法律来源与适用边界'),
        ...citations.flatMap(ref => { const s = sources.find(s => s.verificationId === ref.verificationId)!; return [
          { ...p(`《${s.authority!.document.title}》${ref.article} · 来源正文快照核对`), href: s.sourceUrl },
          ...(internal ? [p(`${ref.verificationId} · ${ref.startOffset}–${ref.endOffset} · SHA256 ${ref.quoteHash}`), { kind: 'quote' as const, text: ref.quote }] : []),
          p(`来源获取时间：${s.authority!.document.fetchedAt}；仅使用原保存快照，未重新联网核验现行效力。来源核验不代表本案事实已证实。`) ] }),
        ...(internal ? [p(`独立蕴含校验：${analysis.entailment.checks.length}项支持；不等同于案件结论或人工适用性审查。`)] : [])]
    }))] }))
}

export function buildInternalResearchReport(input: unknown, now = new Date()) {
  const base = buildReport(input, now), conditionalResearch = validatedConditionalResearch(input)
  return { ...base, title: '内部研究报告', appendix: [], conditionalResearch, sections: conditionalResearch ? [
    { title: '研究范围与覆盖', blocks: [p(`全部 ${conditionalResearch.questionCount} 个问题；已形成条件分析 ${conditionalResearch.acceptedCount} 个。未完成项保留，不等于整案研究通过。`),
      p(`Case snapshot：${conditionalResearch.caseSnapshotId}`), ...conditionalResearch.questions.map(q => p(`${q.question.id} · ${q.status}${q.diagnostic ? ` · ${q.diagnostic.stage} · ${q.diagnostic.reason}` : ''}`))] },
    { title: '案件事实与材料', blocks: base.facts.map(f => p(`${f.id} · ${f.certainty} · ${f.content}`)) },
    ...conditionalReportSections(conditionalResearch, input, true),
    { title: '旧条文摘录链诊断', blocks: [p(`旧链研究状态 ${base.researchStatus}；摘录 ${base.ruleEvidence.length} 条；确定结论 ${base.supportedClaims.filter(c => c.support.claimType === 'LEGAL_CONCLUSION').length} 项。条件分析不修改旧 Application 或发布门槛。`)] },
  ] : base.sections }
}
