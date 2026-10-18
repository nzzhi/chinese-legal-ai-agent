import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { WorkspaceError, type EvidenceWorkspace } from '../caseEvidence/workspace.js'
import { caseSchema } from '../case/caseSchema.js'
import { caseEvidenceInputSchema } from '../caseEvidence/caseEvidence.js'
import { legalQuestionSchema } from '../legalQuestion/legalQuestionSchema.js'
import { analysisDraftSchema, checkedInput, validateConditionalAnalysis, type ConditionalAnalysisInput } from '../legalRule/conditionalAnalysis.js'
import { analyzeNormativeQuestion, buildNormativeGenerationRequest, type NormativeStage } from '../legalRule/normativeRule.js'
import { loadModelConfig } from '../config/modelConfig.js'
import { AcceptanceBudget, AcceptanceBudgetError } from '../integration/acceptanceBudget.js'
import { OpenAICompatibleModelClient, type ModelRequest, type ModelResponse } from '../llm/modelClient.js'
import { ModelRouter } from '../llm/modelRouter.js'
import { buildInternalResearchReport } from '../report/conditionalResearchReport.js'
import { ResearchCache } from './researchCache.js'
import { AuthorityCorpus } from '../authority/authorityCorpus.js'
import { LocalAuthorityVerifier } from '../verification/providers/localAuthorityVerifier.js'

export const controlledLimits = Object.freeze({ queries: 1, verifications: 3, httpRequests: 3, durationMs: 420_000 })
export const recoveryLimits = Object.freeze({ queries: 1, verifications: 3, httpRequests: 4, durationMs: 600_000 })
const stages = ['NORMATIVE_IR', 'ENTAILMENT', 'APPLICATION'] as const
const recoveryStages = ['AUTHORITY_APPLICABILITY', ...stages] as const
const recoveryCaps = { AUTHORITY_APPLICABILITY: 12_000, NORMATIVE_IR: 20_000, ENTAILMENT: 50_000, APPLICATION: 20_000 }
const caps = [20_000, 50_000, 20_000]
export const controlledPlanSchema = z.strictObject({ key: z.string().regex(/^[a-f0-9]{32}$/),
  inputPath: z.string(), contextPath: z.string(), evidenceRoot: z.string(), artifactRoot: z.string(),
  inputSha256: z.string(), contextSha256: z.string(), pricingCheckedAt: z.string().datetime(),
  codeFiles: z.array(z.strictObject({ path: z.string(), sha256: z.string() })).min(1),
  recovery: z.literal(true).optional(), corpusPath: z.string().optional(), modelFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() })
export type ControlledPlan = z.infer<typeof controlledPlanSchema>
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const inputSchema = z.object({ caseSnapshotId: z.string(), case: caseSchema, caseEvidence: caseEvidenceInputSchema,
  legalQuestions: z.array(legalQuestionSchema).length(1), candidateVerifications: z.array(z.unknown()),
  authorityApplicability: z.strictObject({ caseSnapshotId: z.string(), questions: z.array(z.strictObject({
    legalQuestionId: z.string(), authorities: analysisDraftSchema.shape.authorities })).length(1) }).optional() })
const contextSchema = z.object({ rawCase: z.string(), case: caseSchema, caseEvidence: caseEvidenceInputSchema,
  caseSnapshotId: z.string(), legalQuestions: z.array(legalQuestionSchema), candidateVerifications: z.array(z.unknown()) }).passthrough()
const journalSchema = z.strictObject({ status: z.enum(['RUNNING', 'PAUSED', 'PASSED', 'BLOCKED']),
  folder: z.string().uuid(), ledger: z.unknown(), audit: z.array(z.strictObject({ request: z.string().regex(/^[a-f0-9]{64}$/),
    response: z.string().regex(/^[a-f0-9]{64}$/).optional(), folder: z.string().uuid().optional() })).max(4) })
const auditedRequestSchema = z.object({ stage: z.enum(recoveryStages), model: z.enum(['deepseek-flash', 'deepseek-v4-flash']),
  messages: z.array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(2_000_000) })).min(1),
  temperature: z.literal(0), maxTokens: z.number().int().positive(), retryOnTimeout: z.literal(false), reasoningEffort: z.literal('none').optional(),
  diagnosticContext: z.strictObject({ stage: z.literal('ENTAILMENT'), targetIds: z.array(z.string()).min(1).max(160) }).optional() })
class LocalPause extends Error {}

/** Reserve the whole request before HTTP; unknown usage never releases the reservation. */
export class ControlledModelLedger {
  readonly calls: Array<Record<string, unknown>> = []
  private inputReserved = 0
  private outputReserved = 0
  private knownTokens = 0
  private knownInput = 0
  private knownOutput = 0
  private failed = false
  constructor(private readonly limits = { inputTokens: 60_000, totalTokens: 150_000, usd: 0.13, calls: 3 },
    private readonly stageCaps: Record<string, number> = { NORMATIVE_IR: 20_000, ENTAILMENT: 50_000, APPLICATION: 20_000 },
    private readonly sequence: readonly string[] | null = stages,
    private readonly reasoningEfforts: Record<string, ModelRequest['reasoningEffort']> = { NORMATIVE_IR: 'none' }) {}
  reserve(stage: string, request: ModelRequest) {
    const n = this.calls.length, input = Buffer.byteLength(JSON.stringify(request.messages)) + 2048
    const output = request.maxTokens ?? 0
    if (this.failed || n >= this.limits.calls || this.sequence && stage !== this.sequence[n]
      || !this.stageCaps[stage] || output !== this.stageCaps[stage] || request.retryOnTimeout !== false
      || request.reasoningEffort !== this.reasoningEfforts[stage]
      || this.inputReserved + input > this.limits.inputTokens || this.inputReserved + input + this.outputReserved + output > this.limits.totalTokens
      || (this.inputReserved + input) * 3 + (this.outputReserved + output) * 12 > this.limits.usd * 1e7) {
      this.failed = true
      throw new AcceptanceBudgetError('BUDGET_EXCEEDED', 'Controlled stage/token/cost reservation refused before HTTP')
    }
    this.inputReserved += input; this.outputReserved += output
    const call = { number: n + 1, stage, inputUpper: input, outputCap: output, usage: 'UNKNOWN' as unknown }
    this.calls.push(call)
    return call
  }
  complete(call: ReturnType<ControlledModelLedger['reserve']>, response: ModelResponse) {
    const u = response.usage
    if (!this.calls.includes(call) || call.usage !== 'UNKNOWN'
      || !u || ![u.promptTokens, u.completionTokens, u.totalTokens].every(v => Number.isSafeInteger(v) && v! >= 0)
      || u.promptTokens! > call.inputUpper || u.completionTokens! > call.outputCap
      || u.totalTokens !== u.promptTokens! + u.completionTokens!
      || u.reasoningTokens !== undefined && (!Number.isSafeInteger(u.reasoningTokens) || u.reasoningTokens < 0 || u.reasoningTokens > u.completionTokens!)
      || (u.promptCacheHitTokens !== undefined || u.promptCacheMissTokens !== undefined)
        && (![u.promptCacheHitTokens,u.promptCacheMissTokens].every(v => Number.isSafeInteger(v) && v! >= 0)
          || u.promptCacheHitTokens! + u.promptCacheMissTokens! !== u.promptTokens)) {
      this.failed = true
      throw new AcceptanceBudgetError('BUDGET_EXCEEDED', 'Missing/inconsistent usage or provider exceeded reserved token bounds; stop')
    }
    this.inputReserved -= call.inputUpper - u.promptTokens!
    this.outputReserved -= call.outputCap - u.completionTokens!
    call.usage = u; this.knownTokens += u.totalTokens!; this.knownInput += u.promptTokens!; this.knownOutput += u.completionTokens!
  }
  stop() { this.failed = true }
  snapshot() { return { calls: this.calls, inputReserved: this.inputReserved, outputReserved: this.outputReserved,
    totalReserved: this.inputReserved + this.outputReserved, reservedUSD: (this.inputReserved * 3 + this.outputReserved * 12) / 1e7,
    knownTokens: this.knownTokens, knownUSDUpper: (this.knownInput * 3 + this.knownOutput * 12) / 1e7,
    unknownUsageCalls: this.calls.filter(c => c.usage === 'UNKNOWN').length } }
}

/** Opt-in isolated workbench only. The ordinary runtime and full-case request stay unchanged. */
export class ControlledAcceptance {
  readonly plan: ControlledPlan
  constructor(plan: unknown, readonly authorized = false) {
    this.plan = controlledPlanSchema.parse(plan)
    for (const path of [this.plan.evidenceRoot, this.plan.artifactRoot, this.plan.inputPath, this.plan.contextPath]) {
      if (!resolve(path).startsWith(resolve('output') + sep)) throw new WorkspaceError('验收必须使用 output 中的隔离副本')
    }
    if (this.plan.recovery && (!this.plan.corpusPath || !this.plan.modelFingerprint)) throw new WorkspaceError('恢复验收需要指定本地法源库及模型指纹', 409)
  }
  private journal() {
    const path = join(this.plan.artifactRoot, 'journal.json')
    return existsSync(path) ? journalSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined
  }
  private marker() {
    const path = join(this.plan.artifactRoot, 'live-started.json')
    if (!existsSync(path)) return undefined
    const marker = z.object({ at: z.string().datetime(), plan: controlledPlanSchema, runId: z.string().uuid().optional() }).parse(JSON.parse(readFileSync(path, 'utf8')))
    if (!isDeepStrictEqual(marker.plan, this.plan) || Date.parse(marker.at) > Date.now()) throw new WorkspaceError('验收起点或计划变化', 409)
    return marker
  }
  operationLimits() {
    if (!this.plan.recovery) return controlledLimits
    const marker = this.marker(), remaining = marker ? Date.parse(marker.at) + recoveryLimits.durationMs - Date.now() : recoveryLimits.durationMs
    if (remaining <= 0) throw new AcceptanceBudgetError('DEADLINE_EXCEEDED', '恢复验收原600秒期限已到')
    return { ...recoveryLimits, httpRequests: marker ? 1 : 4, durationMs: remaining }
  }
  private ledger(journal?: z.infer<typeof journalSchema>) {
    const ledger = new ControlledModelLedger({ inputTokens: 148_000, totalTokens: 250_000, usd: .25, calls: 4 }, recoveryCaps, recoveryStages)
    if (journal) {
      for (const [index, audit] of journal.audit.entries()) {
        const folder = join(this.plan.artifactRoot, audit.folder ?? journal.folder), requestPath = join(folder, `model-${index + 1}-request.json`), responsePath = join(folder, `model-${index + 1}-response.json`)
        if (!audit.response || sha(readFileSync(requestPath)) !== audit.request || sha(readFileSync(responsePath)) !== audit.response) throw new WorkspaceError('原请求/响应审计指纹变化或用量未知', 409)
        const request = auditedRequestSchema.parse(JSON.parse(readFileSync(requestPath, 'utf8')))
        const call = ledger.reserve(request.stage, request)
        const response = z.object({ text: z.string().max(2_000_000), model: z.enum(['deepseek-flash', 'deepseek-v4-flash']),
          finishReason: z.literal('STOP'), usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number() }).passthrough() })
          .parse(JSON.parse(readFileSync(responsePath, 'utf8'))) as ModelResponse
        if (response.finishReason !== 'STOP' || !['deepseek-flash', 'deepseek-v4-flash'].includes(response.model)) throw new WorkspaceError('原响应不完整或模型未知', 409)
        ledger.complete(call, response)
      }
      if (journal.audit.length !== 3 || !isDeepStrictEqual(JSON.parse(JSON.stringify(ledger.snapshot())), journal.ledger)) throw new WorkspaceError('恢复预算账本不一致', 409)
    }
    return ledger
  }
  private async reverify(input: ConditionalAnalysisInput) {
    const corpus = new AuthorityCorpus(this.plan.corpusPath!, { readOnly: true })
    try {
      const verifier = new LocalAuthorityVerifier(corpus), current = structuredClone(input)
      for (const v of current.candidateVerifications) {
        v.result = await verifier.verify({ retrieval: v.retrieval, candidateSourceId: v.candidate.sourceId, query: v.query, legalQuestion: current.legalQuestions[0] })
        if (v.result.status !== 'VERIFIED') throw new WorkspaceError('当前法源快照重核未通过；禁止模型HTTP', 409)
      }
      checkedInput(current); return current
    } finally { corpus.close() }
  }
  private load() {
    for (const file of this.plan.codeFiles) if (sha(readFileSync(file.path)) !== file.sha256) throw new WorkspaceError('预检后代码或构建已变化，请重新预检', 409)
    const inputBytes = readFileSync(this.plan.inputPath), contextBytes = readFileSync(this.plan.contextPath)
    if (sha(inputBytes) !== this.plan.inputSha256 || sha(contextBytes) !== this.plan.contextSha256) throw new WorkspaceError('验收输入指纹变化，请重新零付费预检', 409)
    // checkedInput validates every candidate's schema and provenance after the outer schema.
    const input = inputSchema.parse(JSON.parse(inputBytes.toString())) as ConditionalAnalysisInput
    checkedInput(input)
    const context = contextSchema.parse(JSON.parse(contextBytes.toString()))
    const question = input.legalQuestions[0], candidates = context.candidateVerifications as ConditionalAnalysisInput['candidateVerifications']
    if (input.caseSnapshotId !== context.caseSnapshotId || !isDeepStrictEqual(input.case, context.case)
      || !isDeepStrictEqual(input.caseEvidence, context.caseEvidence)
      || !isDeepStrictEqual(question, context.legalQuestions.find(q => q.id === question.id))
      || !isDeepStrictEqual(input.candidateVerifications, candidates.filter(v => v.query.legalQuestionId === question.id))) throw new WorkspaceError('单题缓存与报告上下文不匹配', 409)
    if (this.plan.recovery && input.authorityApplicability) throw new WorkspaceError('四阶段验收不得跳过Applicability', 409)
    const decisions = input.authorityApplicability?.questions[0]
    if (!this.plan.recovery && !decisions) throw new WorkspaceError('旧单题验收缺适用性缓存', 409)
    if (decisions) {
    if (decisions.legalQuestionId !== question.id || input.authorityApplicability!.caseSnapshotId !== input.caseSnapshotId) throw new WorkspaceError('适用性缓存快照不匹配', 409)
    const selections = validateConditionalAnalysis(input, question, { authorities: decisions.authorities, rules: [], applications: [] }).authoritySelections
    const selected = input.candidateVerifications.filter(v => selections.some(s => s.authorityId === v.result.providerSourceId && s.selectedForRule))
      .map(v => ({ authorityId: v.result.providerSourceId!, verificationId: v.result.verificationId,
        article: v.result.verifiedSource!.authority!.article.articleNumber, text: v.result.verifiedSource!.content }))
    if (!selected.length) throw new WorkspaceError('没有已核验且适用的规范来源', 409)
    const config = loadModelConfig()
    if (config.baseURL.replace(/\/$/, '') !== 'https://api.deepseek.com' || !['deepseek-v4-flash', 'deepseek-flash'].includes(config.proModel)) throw new WorkspaceError('验收预算仅覆盖官方 DeepSeek Flash', 409)
    if (Date.now() - Date.parse(this.plan.pricingCheckedAt) > 86_400_000 || Date.parse(this.plan.pricingCheckedAt) > Date.now() + 60_000) throw new WorkspaceError('费率预检已过期，须重新核价；不会自动联网', 409)
    const generation = buildNormativeGenerationRequest(selected, question.questionType, config.proModel, new Map(selections.map(s => [s.authorityId, s.role])))
    const firstReservation = new ControlledModelLedger().reserve('NORMATIVE_IR', generation)
    return { input, context, config, firstReservation }
    }
    const config = loadModelConfig()
    if (sha(Buffer.from(JSON.stringify([config.provider, config.baseURL, config.flashModel, config.proModel]))) !== this.plan.modelFingerprint) throw new WorkspaceError('预检后模型配置已变化', 409)
    if (config.baseURL.replace(/\/$/, '') !== 'https://api.deepseek.com' || !['deepseek-v4-flash', 'deepseek-flash'].includes(config.proModel)) throw new WorkspaceError('仅允许官方Flash预算', 409)
    if (Date.now() - Date.parse(this.plan.pricingCheckedAt) > 86_400_000 || Date.parse(this.plan.pricingCheckedAt) > Date.now()) throw new WorkspaceError('费率预检已过期', 409)
    return { input, context, config, firstReservation: undefined }
  }
  async preflight(workspace: EvidenceWorkspace, key: string) {
    if (key !== this.plan.key || workspace.root !== resolve(this.plan.evidenceRoot)) throw new WorkspaceError('仅允许预检指定隔离案件', 409)
    const { input, context, config, firstReservation } = this.load(), view = await workspace.view(key)
    if (!isDeepStrictEqual(view.case, input.case) || !isDeepStrictEqual(view.evidence, input.caseEvidence) || view.rawCase !== context.rawCase) throw new WorkspaceError('工作台事实或材料已变化，缓存失效；须重新预检', 409)
    if (!/SIMULATED.*TEST DATA/s.test(view.rawCase ?? '') || !view.evidence.items.every(e => /TEST DATA/.test(e.content ?? ''))) throw new WorkspaceError('隔离案件必须显著标记 TEST DATA', 409)
    if (!view.factsConfirmed || view.evidence.items.some(e => e.file?.confirmationStatus === 'PENDING')) throw new WorkspaceError('事实未核对或仍有 PENDING 材料', 409)
    if (this.plan.recovery) {
      await this.reverify(input)
      const marker = this.marker(), journal = this.journal(), paused = journal?.status === 'PAUSED'
      if (journal && !marker) throw new WorkspaceError('原起点记录缺失，不得重新开始或延长期限', 409)
      this.operationLimits()
      if (paused) this.ledger(journal)
      return { status: 'ZERO_PAID_PREFLIGHT_PASSED', key, questionId: input.legalQuestions[0].id, authorized: this.authorized,
        recovery: true, paused, used: !!marker && (!paused || existsSync(join(this.plan.artifactRoot, 'resume-started.json'))),
        model: config.proModel, modelHttpMax: 4, legalHttpMax: 0, retries: 0, totalTokensMax: 250_000, usdMax: .25,
        durationMs: 600_000, remainingDurationMs: this.operationLimits().durationMs, materialAuthenticity: 'TEST_DATA_NOT_VERIFIED' }
    }
    return { status: 'ZERO_PAID_PREFLIGHT_PASSED', key, questionId: input.legalQuestions[0].id,
      authorized: this.authorized, used: existsSync(join(this.plan.artifactRoot, 'live-started.json')),
      model: config.proModel, upstream: 'CACHED_NOT_REEXECUTED', materialAuthenticity: 'TEST_DATA_NOT_VERIFIED',
      modelHttpMax: 3, legalHttpMax: 0, retries: 0, inputTokensMax: 60_000, outputTokensMax: 90_000,
      totalTokensMax: 150_000, usdMax: 0.13, conservativeUSDMax: 0.126, durationMs: 420_000,
      stageTimeoutMs: { NORMATIVE_IR: 120_000, ENTAILMENT: 270_000, APPLICATION: 120_000 }, firstReservation }
  }
  async execute(workspace: EvidenceWorkspace, key: string, id: string, budget: AcceptanceBudget, progress: (stage: string) => void) {
    if (this.plan.recovery && (!this.authorized || !this.marker())) throw new WorkspaceError('四阶段执行必须有当前批次独立授权和启动记录', 409)
    const loaded = this.load(), { context, config } = loaded
    const prior = this.plan.recovery ? this.journal() : undefined, resuming = prior?.status === 'PAUSED'
    if (this.plan.recovery) {
      if (prior && !resuming) throw new WorkspaceError('本批已执行或失败，禁止重复执行', 409)
      const lease = resuming ? JSON.parse(readFileSync(join(this.plan.artifactRoot, 'resume-started.json'), 'utf8')) : this.marker()
      if (z.object({ runId: z.string().uuid() }).parse(lease).runId !== id) throw new WorkspaceError('执行标志不属于当前run，拒绝额外调用', 409)
    }
    const input = this.plan.recovery ? await this.reverify(loaded.input) : loaded.input
    const ledger = this.plan.recovery ? this.ledger(resuming ? prior : undefined) : new ControlledModelLedger()
    const folder = join(this.plan.artifactRoot, id); mkdirSync(folder, { recursive: true, mode: 0o700 })
    const write = (name: string, value: unknown) => writeFileSync(join(folder, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
    let stage: NormativeStage = 'NORMATIVE_IR', failed: unknown, paused = false
    const reusedStages: NormativeStage[] = []
    const audit = prior?.audit.slice() ?? []
    const persist = (status: z.infer<typeof journalSchema>['status']) => {
      if (!this.plan.recovery) return
      const path = join(this.plan.artifactRoot, 'journal.json'), tmp = `${path}.${id}.tmp`
      writeFileSync(tmp, JSON.stringify({ status, folder: resuming ? prior!.folder : id, ledger: ledger.snapshot(), audit }), { mode: 0o600 })
      renameSync(tmp, path)
    }
    const deadlineCheck = () => { budget.check(); this.operationLimits() }
    write('input.json', input); write('upstream-context.json', context)
    try {
      const endpoint = `${config.baseURL.replace(/\/$/, '')}/chat/completions`
      const client = { chat: async (request: ModelRequest) => {
        deadlineCheck()
        if (resuming && stage !== 'APPLICATION') throw new WorkspaceError('前缀缓存未精确命中，禁止重复HTTP', 409)
        const call = ledger.reserve(stage, request)
        write(`model-${call.number}-request.json`, { ...request, signal: undefined, stage })
        if (this.plan.recovery) { audit.push({ folder: id, request: sha(readFileSync(join(folder, `model-${call.number}-request.json`))) }); persist('RUNNING') }
        let sent = false
        const delegate = new OpenAICompatibleModelClient(config, { timeoutMs: stage === 'ENTAILMENT' ? 270_000 : 120_000,
          fetch: budget.networkFetch(async (url, init) => {
            const http = new Request(url, init)
            if (sent || http.url !== endpoint || http.method !== 'POST') throw new AcceptanceBudgetError('BUDGET_EXCEEDED', 'Extra/foreign HTTP refused')
            deadlineCheck(); sent = true; return fetch(http)
          }), onResponse: body => write(`model-${call.number}-provider.raw.json`, body) })
        try {
          const response = await budget.model(delegate).chat(request)
          write(`model-${call.number}-response.json`, response)
          if (!['deepseek-v4-flash', 'deepseek-flash'].includes(response.model)) throw new Error('Unexpected response model; fee reservation no longer valid')
          ledger.complete(call, response)
          if (response.finishReason !== 'STOP') throw new Error('Incomplete model completion; stop')
          if (this.plan.recovery) { audit[call.number - 1].response = sha(readFileSync(join(folder, `model-${call.number}-response.json`))); persist('RUNNING') }
          return response
        } catch (error) { ledger.stop(); throw error }
        finally { write(`model-${call.number}-receipt.json`, { ...call, sent }) }
      } }
      const cache = this.plan.recovery ? new ResearchCache(join(this.plan.artifactRoot, 'cache'), budget.signal, resuming) : undefined
      const cached = cache ? cache.model(client, () => reusedStages.push(stage)) : client
      const checkedClient = { chat: async (request: ModelRequest) => {
        deadlineCheck()
        const response = await (this.plan.recovery && stage === 'APPLICATION' ? client : cached).chat(request)
        if (resuming && stage !== 'APPLICATION') {
          const n = recoveryStages.indexOf(stage as typeof recoveryStages[number]) + 1
          const oldFolder = join(this.plan.artifactRoot, prior!.folder), originalRequest = JSON.parse(readFileSync(join(oldFolder, `model-${n}-request.json`), 'utf8'))
          const { stage: _stage, ...payload } = originalRequest
          const { signal: _signal, ...current } = request
          const originalResponse = JSON.parse(readFileSync(join(oldFolder, `model-${n}-response.json`), 'utf8')) as ModelResponse
          if (!isDeepStrictEqual(payload, current) || response.text !== originalResponse.text || response.model !== originalResponse.model || response.finishReason !== 'STOP') throw new WorkspaceError('缓存与原审计响应不一致', 409)
        }
        return response
      } }
      // Call the shared strict chain directly: content failures must stop this acceptance, not continue other questions.
      const analysis = await budget.run(() => analyzeNormativeQuestion(input, input.legalQuestions[0], checkedClient, new ModelRouter(config), (next, _question, value) => {
        deadlineCheck(); stage = next; progress(next)
        if (this.plan.recovery && !resuming && next === 'APPLICATION' && value === undefined) throw new LocalPause('三阶段严格成功，本地暂停于Application之前')
        if (value !== undefined) write(`${next}.json`, value)
      }))
      const result = { ...context, researchStatus: 'INDETERMINATE', conditionalAnalysis: { caseSnapshotId: input.caseSnapshotId, questions: [analysis], blocked: [] },
        ...(this.plan.recovery ? { candidateVerifications: [...(context.candidateVerifications as ConditionalAnalysisInput['candidateVerifications']).filter(v => v.query.legalQuestionId !== analysis.legalQuestionId), ...input.candidateVerifications] } : {}),
        questionDiagnostics: context.legalQuestions.filter(q => q.id !== analysis.legalQuestionId).map(q => ({ legalQuestionId: q.id, status: 'NOT_RUN', stage: 'NOT_STARTED', reason: '受控单题验收：本轮未执行此题' })),
        metrics: { totalDurationMs: this.plan.recovery ? Date.now() - Date.parse(this.marker()!.at) : budget.snapshot().elapsedMs, stageTimings: [], llmCallCount: ledger.calls.length,
          llmCallsByModel: { [config.proModel]: ledger.calls.length }, retrievalOperationCount: 0, retrievalReuseCount: 0,
          retrievalHttpRequestCount: 0, verificationOperationCount: 0, verificationHttpRequestCount: 0 },
        controlledAcceptance: { questionId: analysis.legalQuestionId, upstreamReused: true, materialAuthenticity: 'TEST_DATA_NOT_VERIFIED', ledger: ledger.snapshot(), reusedStages } }
      buildInternalResearchReport(result); budget.check(); write('result.json', result)
      await budget.run(() => workspace.saveResearch(key, id, result)); budget.check()
      await budget.run(() => workspace.regenerateReport(key)); budget.check()
      deadlineCheck(); persist('PASSED')
      write('success.json', { status: 'CONTROLLED_MODEL_CHAIN_AND_DUAL_REPORTS_PASSED', questionId: analysis.legalQuestionId, materialAuthenticity: 'TEST_DATA_NOT_VERIFIED' })
    } catch (error) {
      if (error instanceof LocalPause) {
        try {
          await workspace.updateResearch(key, id, '前缀完成，等待恢复', '本地暂停；同一预算和原600秒期限继续计时。重新预检后恢复Application。')
          // Publish resumability only after the old workspace run has stopped writing.
          persist('PAUSED'); paused = true
          write('paused.json', { status: 'PAUSED', ledger: ledger.snapshot() }); return
        } catch (pauseError) { paused = false; failed = pauseError; persist('BLOCKED'); throw pauseError }
      }
      failed = error; persist('BLOCKED'); throw error
    }
    finally { write('summary.json', { status: paused ? 'PAUSED' : failed ? 'BLOCKED' : 'PASSED', error: failed instanceof Error ? failed.message : undefined,
      stage, budget: budget.snapshot(), ledger: ledger.snapshot(), legalHttp: 0, retries: 0, reusedStages,
      ...(this.plan.recovery ? { cumulativeDurationMs: Date.now() - Date.parse(this.marker()!.at) } : {}) }) }
  }
  claim(runId?: string) {
    if (!this.authorized) throw new WorkspaceError('零付费预检模式：尚未获得本次 LIVE 独立授权', 409)
    mkdirSync(this.plan.artifactRoot, { recursive: true, mode: 0o700 })
    const resume = this.plan.recovery && this.journal()?.status === 'PAUSED'
    if (resume) { this.operationLimits(); this.ledger(this.journal()) }
    try { writeFileSync(join(this.plan.artifactRoot, resume ? 'resume-started.json' : 'live-started.json'), JSON.stringify({ at: new Date().toISOString(), plan: this.plan, runId }), { flag: 'wx', mode: 0o600 }) }
    catch { throw new WorkspaceError('本次验收已启动过，拒绝重复调用；需要新计划和独立授权', 409) }
  }
}
