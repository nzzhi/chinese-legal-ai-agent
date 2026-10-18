import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { caseSchema, type Case } from '../case/caseSchema.js'
import { assertCaseSnapshot, assertQuestionFacts } from '../case/caseSnapshot.js'
import { assessCaseEvidence, caseEvidenceInputSchema, type CaseEvidenceInput } from '../caseEvidence/caseEvidence.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import type { CandidateVerification } from '../integration/researchWorkflow.js'
import type { ModelClient } from '../llm/modelClient.js'
import type { ModelRouter } from '../llm/modelRouter.js'
import { sourceVerificationResultSchema } from '../verification/sourceVerificationSchema.js'

const text = z.string().trim().min(1).max(6000)
const ids = z.array(text).max(50).refine(v => new Set(v).size === v.length, 'Duplicate IDs')
const role = z.enum(['CORE', 'SUPPORTING', 'EVIDENTIARY', 'PROCEDURAL', 'NOT_NEEDED', 'NOT_APPLICABLE'])
const applicability = z.enum(['APPLICABLE', 'CONDITIONALLY_APPLICABLE', 'NOT_APPLICABLE', 'INSUFFICIENT_FACTS'])
export function authorityFunctionRole(body: string, declared: z.infer<typeof role>) {
  // ponytail: explicit filing/electronic-data clauses; other normative functions remain model-qualified.
  return /起诉必须符合下列条件|起诉状应当记明下列事项/.test(body) ? 'PROCEDURAL' as const
    : /电子数据/.test(body) && /原件|真实性/.test(body) ? 'EVIDENTIARY' as const : declared
}
const ref = z.strictObject({ authorityId: text, quote: text })
const refs = z.array(ref).min(1).max(20)
const clause = z.strictObject({ text, support: refs })
export const analysisDraftSchema = z.strictObject({
  authorities: z.array(z.strictObject({ authorityId: text, status: applicability, role, selectedForRule: z.boolean(), reason: text,
    requiredConditions: z.array(z.strictObject({ text, kind: z.enum(['GENERAL', 'SPECIAL_SCENARIO']), support: refs,
      factIds: ids, missingReason: z.string().max(6000) })).max(20) })).max(30),
  rules: z.array(z.strictObject({ ruleId: text, proposition: text,
    conditions: z.array(z.strictObject({ conditionId: text, text, support: refs })).min(1).max(20),
    consequence: clause, limitations: z.array(clause).max(20), authorityIds: ids.min(1) })).max(5),
  applications: z.array(z.strictObject({ ruleId: text, conditionAssessments: z.array(z.strictObject({
    conditionId: text, factIds: ids, gaps: z.array(text).max(20), reasoning: text,
  })).min(1).max(20) })).max(5),
})
export type AnalysisDraft = z.infer<typeof analysisDraftSchema>
export interface ConditionalAnalysisInput {
  caseSnapshotId: string; case: Case; caseEvidence: CaseEvidenceInput;
  legalQuestions: LegalQuestion[]; candidateVerifications: CandidateVerification[]
  authorityApplicability?: { caseSnapshotId: string; questions: Array<{
    legalQuestionId: string; authorities: AnalysisDraft['authorities']
  }> }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const normalizedRuleText = (value: string) => value.replace(/^第[零〇一二三四五六七八九十百千万两\d]+条/, '')
  .replace(/[\s\p{P}\p{S}]/gu, '')
/** A short, single normative sentence can itself be an accurate proposition. Quotes remain unrestricted.
 * ponytail: 80 normalized characters / one sentence is a conservative summary boundary, not an entailment test.
 */
export function isCompactNorm(value: string) {
  return normalizedRuleText(value).length <= 80 && (value.match(/[。！？]/g)?.length ?? 0) <= 1
    && !/[（(][一二三四五六七八九十]+[）)]|下列|除外/.test(value)
}
export function isLongArticleCopy(prose: string, source: string) {
  return !isCompactNorm(source) && normalizedRuleText(prose).includes(normalizedRuleText(source))
}
export function jurisdictionBasisGap(prose: string, sourceTexts: string[]) {
  return /管辖/.test(prose) && !sourceTexts.some(s => /(?:由|归)[^。\n]{0,180}人民法院管辖/.test(s))
    ? '法律依据缺口：当前选择的VERIFIED Authority仅提供受诉法院管辖这一程序要求，未提供具体管辖连接点规则；须进一步检索核验，不能从法律常识补入。' : undefined
}
export function assertFactualObservation(prose: string, legalText: string, location: string) {
  for (const claim of prose.match(/被告住所地|合同履行地|合同签订地|诉讼时效|举证责任倒置/g) ?? []) {
    if (!legalText.includes(claim)) throw new Error(`UNSUPPORTED_LEGAL_PROPOSITION: ${location}: unprovided legal concept ${claim}`)
  }
  if (/(?:应当|必须|有权|依法)(?:.{0,16})(?:返还|还款|采信|确认|起诉|管辖)|由.{0,20}(?:确定|管辖)|(?:借款|借贷)关系(?:已经|已)成立/.test(prose)) {
    throw new Error(`UNSUPPORTED_LEGAL_PROPOSITION: ${location}: factual observation contains a free legal conclusion`)
  }
}
const unsafeConclusion = /必然|必定|一定(?:能胜诉|胜诉|会采信|应采信)|法院应当采信|(?:已经|已被)(?:证实|证明)|借贷关系已经成立|被告身份已明确/
function safeReasoning(value: string) {
  if (unsafeConclusion.test(value)) throw new Error('APPLICATION_REASONING_BLOCKED: unsupported certainty')
}

/** Preconditions identified from actual normative wording, never article IDs or case amounts.
 * ponytail: bounded explicit sale-security and early-performance clauses; unknown legal scenarios stay model-qualified, not a legal ontology.
 */
export function specialScenario(text: string) {
  const sale = text.match(/当事人以[^。\n]{0,120}作为[^。\n]{0,80}担保[^。\n]{0,160}的/)
  if (sale) return { quote: sale[0], terms: ['买卖合同', '担保'], name: '买卖合同担保及履行该合同请求' }
  const early = text.match(/借款人[^。\n]{0,30}提前偿还[^。\n]{0,100}/)
  if (early) return { quote: early[0], terms: ['提前', '偿还'], name: '提前偿还' }
}

export function checkedInput(input: ConditionalAnalysisInput) {
  caseSchema.parse(input.case)
  assertCaseSnapshot(input.case, input.caseSnapshotId)
  assertQuestionFacts(input.case, input.legalQuestions, true)
  const evidence = caseEvidenceInputSchema.parse(input.caseEvidence)
  assessCaseEvidence({ case: input.case, evidence, legalQuestions: input.legalQuestions, ruleApplications: [] })
  if (input.legalQuestions.length > 24) throw new Error('Analysis question budget exceeds 24')
  const questions = new Map(input.legalQuestions.map(q => [q.id, q]))
  if (questions.size !== input.legalQuestions.length) throw new Error('Duplicate question IDs')
  for (const v of input.candidateVerifications) {
    sourceVerificationResultSchema.parse(v.result)
    if (v.caseSnapshotId !== input.caseSnapshotId || !questions.has(v.query.legalQuestionId)
      || v.result.legalQuestionId !== v.query.legalQuestionId || v.result.legalSearchQueryId !== v.query.id
      || v.result.retrievalId !== v.retrieval.retrievalId || v.result.candidateSourceId !== v.candidate.sourceId
      || v.result.providerId !== v.retrieval.providerId || v.result.providerSourceId !== v.candidate.record.providerSourceId
      // Public references contain verified page originals, while their candidates contain search snippets.
      // They retain source/schema/provenance checks and are excluded from all normative synthesis below.
      || v.query.sourcePurpose !== 'REFERENCE' && v.result.verifiedSource && (v.result.verifiedSource.content !== v.candidate.record.content
        || !isDeepStrictEqual(v.result.verifiedSource.authority, v.candidate.record.authority))
      || !v.retrieval.sources.some(s => isDeepStrictEqual(s, v.candidate))) throw new Error('STALE_FACT_REFERENCES: authority research snapshot/provenance mismatch')
  }
  return evidence
}

export function bindConditionAssessment(input: ConditionalAnalysisInput, condition: { conditionId: string; text: string }, c: { factIds: string[]; gaps: string[]; reasoning: string }) {
  const evidence = checkedInput(input)
  const factById = new Map(input.case.facts.concat(input.case.disputedFacts).map(f => [f.id, f]))
  if (c.factIds.some(id => !factById.has(id))) throw new Error('APPLICATION_LOGIC_BLOCKED: unknown factId')
  safeReasoning(c.reasoning)
  const facts = c.factIds.map(id => factById.get(id)!)
  const links = evidence.links.filter(l => c.factIds.includes(l.factId) && l.status !== 'CANCELLED')
  const materialStates = [...new Set(links.map(l => l.evidenceId))].map(id => {
    const e = evidence.items.find(i => i.id === id)!
    return { evidenceId: id, source: e.source, parsed: !!e.content,
      linked: links.some(l => l.evidenceId === id && (l.status === 'CONFIRMED' || !l.status) && !!l.review),
      confirmation: e.file?.confirmationStatus ?? 'NOT_UPLOADED',
      authenticity: /TEST DATA|FIXTURE|模拟/.test(e.content ?? '') ? 'SIMULATED' as const : 'NOT_VERIFIED' as const }
  })
  const status = facts.some(f => f.certainty === 'DISPUTED') ? 'CONTRADICTED' as const
    : facts.length === 0 || facts.every(f => f.certainty === 'UNKNOWN') ? 'UNKNOWN' as const
      : 'USER_CLAIM_ONLY' as const // USER_INPUT is never authenticated evidence, even if labelled CONFIRMED.
  const gaps = [...new Set([...c.gaps, ...(status === 'USER_CLAIM_ONLY' ? ['用户陈述仍需真实材料核验；内容关联不等于真实性核验'] : []),
    ...materialStates.filter(m => m.authenticity === 'SIMULATED').map(() => '当前关联材料为TEST DATA，不作为真实案件证据')])]
    .map(gap => ({ gapId: `analysis-gap-${hash([input.caseSnapshotId, condition.conditionId, gap]).slice(0, 24)}`, text: gap }))
  return { conditionId: condition.conditionId, condition: condition.text, status, factIds: c.factIds,
    factStances: facts.map(f => ({ factId: f.id, certainty: f.certainty, source: f.source, content: f.content })),
    evidenceIds: materialStates.map(m => m.evidenceId), materialStates, gaps, reasoning: c.reasoning }
}

/** This validator is shared by the real model stage and negative tests. It never creates a legal proposition. */
export function validateConditionalAnalysis(input: ConditionalAnalysisInput, question: LegalQuestion, raw: unknown) {
  const evidence = checkedInput(input), draft = analysisDraftSchema.parse(raw)
  if (!input.legalQuestions.some(q => isDeepStrictEqual(q, question))) throw new Error('STALE_FACT_REFERENCES: question is not a member of this research snapshot')
  const verified = input.candidateVerifications.filter(v => v.query.legalQuestionId === question.id
    && v.result.status === 'VERIFIED' && v.result.verifiedSource?.authority && v.query.sourcePurpose !== 'REFERENCE')
  const sources = new Map(verified.map(v => [v.result.providerSourceId!, v.result.verifiedSource!]))
  const factById = new Map(input.case.facts.concat(input.case.disputedFacts).map(f => [f.id, f]))
  const knownFacts = (values: string[]) => {
    if (values.some(id => !factById.has(id))) throw new Error('APPLICATION_REASONING_BLOCKED: unknown factId')
  }
  const support = (values: z.infer<typeof refs>, allowed = sources) => values.map(v => {
    const source = allowed.get(v.authorityId)
    if (!source) throw new Error('RULE_SYNTHESIS_BLOCKED: unknown/unselected authorityId')
    const start = source.content.indexOf(v.quote)
    if (start < 0 || v.quote.length < 2) throw new Error('RULE_SYNTHESIS_BLOCKED: proposition quote is not exact source text')
    return { ...v, start, end: start + v.quote.length, quoteHash: createHash('sha256').update(v.quote).digest('hex'), verificationId: source.verificationId,
      article: source.authority!.article.articleNumber }
  })
  if (new Set(draft.authorities.map(a => a.authorityId)).size !== sources.size
    || draft.authorities.length !== sources.size) throw new Error('AUTHORITY_APPLICABILITY_BLOCKED: must classify every verified authority exactly once')
  const selections = draft.authorities.map(a => {
    if (!sources.has(a.authorityId)) throw new Error('AUTHORITY_APPLICABILITY_BLOCKED: unknown authority')
    safeReasoning(a.reason)
    const conditions = a.requiredConditions.map(c => { knownFacts(c.factIds); return { ...c, support: support(c.support) } })
    const scenario = specialScenario(sources.get(a.authorityId)!.content)
    const scenarioFacts = scenario ? input.case.facts.concat(input.case.disputedFacts).filter(f =>
      scenario.terms.every(term => f.content.includes(term)) && !/没有|无.{0,6}(买卖|担保)|未.{0,6}(提前|偿还)|不.{0,6}(提前|担保)/.test(f.content)) : []
    if (scenario && scenarioFacts.length === 0) {
      const missingScenario = { text: scenario.name, kind: 'SPECIAL_SCENARIO' as const,
        factIds: [], missingReason: '当前案件没有该特殊场景陈述', support: support([{ authorityId: a.authorityId, quote: scenario.quote }]) }
      return { ...a, status: 'NOT_APPLICABLE' as const, role: 'NOT_APPLICABLE' as const, selectedForRule: false,
        sourceVerification: 'SOURCE_VERIFIED' as const, reason: `正文要求${scenario.name}，当前Case没有该特殊场景的事实基础`,
        requiredConditions: conditions.some(c => isDeepStrictEqual(c, missingScenario)) ? conditions : [...conditions, missingScenario],
        supportedConditions: [], missingConditions: [scenario.name] }
    }
    const missing = conditions.filter(c => c.factIds.length === 0).map(c => c.text)
    if (a.selectedForRule && !conditions.length) throw new Error('AUTHORITY_APPLICABILITY_BLOCKED: selected authority needs grounded prerequisites')
    const userClaims = conditions.some(c => c.factIds.some(id => factById.get(id)!.source === 'USER_INPUT'))
    const status = a.status === 'APPLICABLE' && userClaims ? 'CONDITIONALLY_APPLICABLE' as const : a.status
    if (a.selectedForRule && (status === 'NOT_APPLICABLE' || status === 'INSUFFICIENT_FACTS'
      || a.role === 'NOT_APPLICABLE' || a.role === 'NOT_NEEDED')) throw new Error('AUTHORITY_APPLICABILITY_BLOCKED: selected authority contradicts status/role')
    const body = sources.get(a.authorityId)!.content
    // Role denotes normative function, not how important it is within this question.
    const functionRole = a.selectedForRule ? authorityFunctionRole(body, a.role) : a.role
    return { ...a, role: functionRole, status, sourceVerification: 'SOURCE_VERIFIED' as const, requiredConditions: conditions,
      supportedConditions: conditions.filter(c => c.factIds.length).map(c => c.text), missingConditions: missing }
  })
  const selected = new Map([...sources].filter(([id]) => selections.some(a => a.authorityId === id && a.selectedForRule)))
  const qscope = hash([input.caseSnapshotId, question.id]).slice(0, 20)
  if (new Set(draft.rules.map(r => r.ruleId)).size !== draft.rules.length) throw new Error('Duplicate rule IDs')
  const rules = draft.rules.map(r => {
    if (!r.authorityIds.length || r.authorityIds.some(id => !selected.has(id))) throw new Error('RULE_SYNTHESIS_BLOCKED: rule uses unselected authority')
    const allowed = new Map([...selected].filter(([id]) => r.authorityIds.includes(id)))
    const prose = [r.proposition, r.consequence.text, ...r.conditions.map(c => c.text), ...r.limitations.map(c => c.text)].join('\n')
    // “与本案有直接利害关系” is generic statutory wording, not a Fact from this Case.
    const caseSpecificProse = [...allowed.values()].some(s => s.content.includes('与本案有直接利害关系'))
      ? prose.replace(/与本案有直接利害关系/g, '') : prose
    if (/用户|本案|朋友说/.test(caseSpecificProse)
      || [...input.case.facts.flatMap(f => [...f.content.matchAll(/\d+(?:\.\d+)?元/g)].map(m => m[0]))]
        .some(amount => prose.includes(amount) && ![...allowed.values()].some(s => s.content.includes(amount)))) {
      throw new Error('RULE_SYNTHESIS_BLOCKED: Rule contains case-specific facts')
    }
    safeReasoning(prose)
    for (const citation of prose.matchAll(/第[零〇一二三四五六七八九十百千万两\d]+条(?:之[一二三四五六七八九十\d]+)?/g)) {
      if (![...allowed.values()].some(s => s.content.includes(citation[0]))) throw new Error('RULE_SYNTHESIS_BLOCKED: unprovided article citation')
    }
    if ([...allowed.values()].some(s => [r.proposition, r.consequence.text, ...r.conditions.map(c => c.text),
      ...r.limitations.map(c => c.text)].some(value => isLongArticleCopy(value, s.content)))) {
      throw new Error(`RULE_SYNTHESIS_BLOCKED: Rule ${r.ruleId}: unchanged full article/long copy cannot replace analysis`)
    }
    if (new Set(r.conditions.map(c => c.conditionId)).size !== r.conditions.length) throw new Error('Duplicate condition IDs')
    if (r.authorityIds.some(id => ![...r.conditions.flatMap(c => c.support), ...r.consequence.support, ...r.limitations.flatMap(c => c.support)].some(s => s.authorityId === id))) {
      throw new Error('RULE_SYNTHESIS_BLOCKED: unused authority reference')
    }
    for (const [id, source] of allowed) {
      if (/应当结合下列因素综合判断/.test(source.content) && r.conditions.some(c => c.support.some(s => s.authorityId === id
        && /[（(][一二三四五六七八九十]+[）)]/.test(s.quote)))) {
        throw new Error(`RULE_SYNTHESIS_BLOCKED: Rule ${r.ruleId}: assessment factors require Normative IR, not necessary conditions`)
      }
      if (/可以确认其真实性/.test(source.content) && /应当确认其真实性/.test(source.content)) {
        throw new Error(`RULE_SYNTHESIS_BLOCKED: Rule ${r.ruleId}: distinct confirmation paths/effects require Normative IR branches`)
      }
      if (/除外|但有|但当事人另有约定/.test(source.content)
        && !r.limitations.some(l => l.support.some(s => s.authorityId === id && /除外|但有|但当事人另有约定/.test(s.quote)))) {
        throw new Error('RULE_SYNTHESIS_BLOCKED: explicit source exception must be retained with an exact quote')
      }
    }
    if (question.questionType === 'PROCEDURE' && selections.filter(a => r.authorityIds.includes(a.authorityId))
      .every(a => a.role === 'PROCEDURAL') && /返还借款|偿还借款|还款义务|承担.*还款/.test(r.consequence.text)) {
      throw new Error('RULE_SYNTHESIS_BLOCKED: procedural Rule cannot impose repayment liability')
    }
    return { ...r, ruleId: `synthesized-rule-${qscope}-${r.ruleId}`, legalQuestionId: question.id,
      caseSnapshotId: input.caseSnapshotId,
      conditions: r.conditions.map(c => ({ ...c, conditionId: `condition-${qscope}-${r.ruleId}-${c.conditionId}`, support: support(c.support, allowed) })),
      consequence: { ...r.consequence, support: support(r.consequence.support, allowed) },
      limitations: r.limitations.map(c => ({ ...c, support: support(c.support, allowed) })) }
  })
  if (draft.applications.length !== rules.length || new Set(draft.applications.map(a => a.ruleId)).size !== rules.length) {
    throw new Error('APPLICATION_REASONING_BLOCKED: one application per synthesized rule required')
  }
  const applications = draft.applications.map(a => {
    const original = draft.rules.find(r => r.ruleId === a.ruleId)
    if (!original) throw new Error('APPLICATION_REASONING_BLOCKED: unknown ruleId')
    const r = rules[draft.rules.indexOf(original)]
    if (a.conditionAssessments.length !== original.conditions.length
      || new Set(a.conditionAssessments.map(c => c.conditionId)).size !== original.conditions.length) throw new Error('APPLICATION_REASONING_BLOCKED: all rule conditions must be assessed exactly once')
    const assessments = a.conditionAssessments.map(c => {
      knownFacts(c.factIds); safeReasoning(c.reasoning)
      const originalCondition = original.conditions.find(x => x.conditionId === c.conditionId)
      if (!originalCondition) throw new Error('APPLICATION_REASONING_BLOCKED: unknown conditionId')
      const condition = r.conditions[original.conditions.indexOf(originalCondition)]
      // Legacy prose is retained for replay, but cannot import normative concepts absent from this selected rule.
      for (const claim of [c.reasoning, ...c.gaps].join('\n').match(/被告住所地|合同履行地|合同签订地|诉讼时效|举证责任倒置/g) ?? []) {
        if (![...selected].filter(([id]) => original.authorityIds.includes(id)).some(([, s]) => s.content.includes(claim))) {
          throw new Error(`UNSUPPORTED_LEGAL_PROPOSITION: Rule ${a.ruleId} condition ${c.conditionId} Application: unprovided legal concept ${claim}`)
        }
      }
      return bindConditionAssessment(input, condition, c)
    })
    const adverse = assessments.filter(c => c.status === 'CONTRADICTED').flatMap(c => c.factIds)
    return { applicationId: `conditional-application-${qscope}-${a.ruleId}`, ruleId: r.ruleId, legalQuestionId: question.id,
      caseSnapshotId: input.caseSnapshotId, conditionAssessments: assessments,
      logicStatus: 'LEGACY_UNSPECIFIED' as const,
      legalBasisGaps: [jurisdictionBasisGap(r.conditions.map(c => c.text).join('\n'),
        r.authorityIds.map(id => selected.get(id)!.content))].filter((gap): gap is string => !!gap),
      overallAssessment: { status: adverse.length ? 'UNKNOWN' as const : 'CONDITIONAL' as const,
        strength: adverse.length ? 'ADVERSE' as const : assessments.some(c => c.factIds.length) ? 'MIXED' as const : 'INSUFFICIENT' as const,
        favorableFactIds: [...new Set(assessments.filter(c => c.status === 'USER_CLAIM_ONLY').flatMap(c => c.factIds))],
        uncertainGapIds: assessments.flatMap(c => c.gaps.map(g => g.gapId)), adverseFactIds: adverse,
        reasoning: `逐项核对：${r.conditions.map(c => c.text).join('；')}。兼容结构未声明条件组合逻辑，不能把所有条件默认合并为共同必要条件或据此推导效果；分支推理须使用Normative IR。当前条件仅有陈述或仍缺材料，不能视为已证实。` } }
  })
  return { caseSnapshotId: input.caseSnapshotId, legalQuestionId: question.id, authoritySelections: selections,
    rules, applications }
}
export type ConditionalQuestionAnalysis = ReturnType<typeof validateConditionalAnalysis> | import('./normativeRule.js').NormativeQuestionAnalysis
export const conditionalQuestionBlockSchema = z.strictObject({ legalQuestionId: text, status: z.literal('BLOCKED'),
  stage: z.enum(['AUTHORITY_APPLICABILITY', 'NORMATIVE_IR', 'RULE_RENDER', 'ENTAILMENT', 'APPLICATION', 'NOT_STARTED']),
  reason: z.string().max(6000) })
export type ConditionalQuestionBlock = z.infer<typeof conditionalQuestionBlockSchema>
export interface ConditionalAnalysisResult { caseSnapshotId: string; questions: ConditionalQuestionAnalysis[];
  blocked?: ConditionalQuestionBlock[] }
export interface ConditionalAnalyzer { analyze(input: ConditionalAnalysisInput): Promise<ConditionalAnalysisResult> }

export class ModelConditionalAnalyzer implements ConditionalAnalyzer {
  constructor(private readonly client: ModelClient, private readonly router: ModelRouter,
    private readonly observer?: import('./normativeRule.js').NormativeObserver,
    private readonly execution: {
      concurrency?: 1 | 2; signal?: AbortSignal;
      load?: (input: ConditionalAnalysisInput) => Promise<ConditionalQuestionAnalysis[]>;
      save?: (input: ConditionalAnalysisInput, result: ConditionalQuestionAnalysis) => Promise<void>;
      onQuestion?: (id: string, status: 'QUEUED' | 'STARTED' | 'COMPLETED' | 'BLOCKED' | 'REUSED') => void;
    } = {}) {}
  async analyze(input: ConditionalAnalysisInput): Promise<ConditionalAnalysisResult> {
    checkedInput(input)
    const { analyzeNormativeQuestion, NormativeContentError } = await import('./normativeRule.js')
    const questions: ConditionalQuestionAnalysis[] = await this.execution.load?.(input) ?? [], blocked: ConditionalQuestionBlock[] = []
    const remaining = input.legalQuestions.filter(q => !questions.some(saved => saved.legalQuestionId === q.id))
    for (const saved of questions) this.execution.onQuestion?.(saved.legalQuestionId, 'REUSED')
    for (const question of remaining) this.execution.onQuestion?.(question.id, 'QUEUED')
    let cursor = 0, failure: unknown
    const controller = new AbortController()
    const signal = this.execution.signal ? AbortSignal.any([controller.signal, this.execution.signal]) : controller.signal
    const client: ModelClient = { chat: request => this.client.chat({ ...request,
      signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal }) }
    const worker = async () => {
      try {
        while (cursor < remaining.length && failure === undefined) {
          signal.throwIfAborted()
          const question = remaining[cursor++]
          let stage: ConditionalQuestionBlock['stage'] = 'NOT_STARTED'
          try {
            this.execution.onQuestion?.(question.id, 'STARTED')
            const result = await analyzeNormativeQuestion(input, question, client, this.router, (next, questionId, value) => {
              stage = next
              this.observer?.(next, questionId, value)
            })
            signal.throwIfAborted()
            await this.execution.save?.(input, result)
            questions.push(result)
            this.execution.onQuestion?.(question.id, 'analysisStatus' in result && result.analysisStatus === 'NO_VERIFIED_AUTHORITY' ? 'BLOCKED' : 'COMPLETED')
          } catch (error) {
            // Transport, stale snapshots, observer and unknown programming errors still fail the run.
            if (!(error instanceof NormativeContentError)) throw error
            checkedInput(input)
            blocked.push({ legalQuestionId: question.id, status: 'BLOCKED', stage, reason: error.message.slice(0, 6000) })
            this.execution.onQuestion?.(question.id, 'BLOCKED')
          }
        }
      } catch (error) { failure ??= error; controller.abort(error) }
    }
    // Wait for in-flight siblings before closing the corpus or starting another run.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(this.execution.concurrency ?? 1, remaining.length) }, worker))
    if (failure !== undefined) throw failure
    for (const result of settled) if (result.status === 'rejected') throw result.reason
    questions.sort((a, b) => input.legalQuestions.findIndex(q => q.id === a.legalQuestionId) - input.legalQuestions.findIndex(q => q.id === b.legalQuestionId))
    blocked.sort((a, b) => input.legalQuestions.findIndex(q => q.id === a.legalQuestionId) - input.legalQuestions.findIndex(q => q.id === b.legalQuestionId))
    return { caseSnapshotId: input.caseSnapshotId, questions, blocked }
  }
}
