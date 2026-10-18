import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PreliminaryQualityError } from '../assistant/preliminaryQuality.js'
import { EvidenceWorkspace, WorkspaceError } from '../caseEvidence/workspace.js'
import { renderUserHtml, renderUserMarkdown } from '../report/userCaseReport.js'
import { createHash, randomUUID } from 'node:crypto'
import { caseSchema } from '../case/caseSchema.js'
import { AcceptanceBudget, AcceptanceBudgetError, type AcceptanceLimits } from '../integration/acceptanceBudget.js'
import { ResearchWorkflow } from '../integration/researchWorkflow.js'
import { createWorkbenchRuntime, type WorkbenchRuntimeFactory } from './researchRuntime.js'
import { safeFailureDiagnostic } from '../integration/failureDiagnostic.js'
import type { QueryDomainDiagnostic } from '../legalQuery/queryDomainDiagnostic.js'
import { ControlledAcceptance } from './controlledAcceptance.js'
import type { FullCaseAcceptance } from './fullCaseAcceptance.js'

// Source development uses web/; compiled services use their own bundled web/.
const webRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../web/' : '../web/', import.meta.url))

export function buildWorkbenchApp(options: { evidenceRoot?: string; runtimeFactory?: WorkbenchRuntimeFactory;
  siteOrigin?: string; executionMode?: 'OFFLINE'; researchLimits?: AcceptanceLimits; researchMode?: 'PRELIMINARY' | 'STRICT'; controlledAcceptance?: ControlledAcceptance; fullCaseAcceptance?: FullCaseAcceptance } = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 })
  const workspace = new EvidenceWorkspace(options.evidenceRoot)
  const fullCase=options.fullCaseAcceptance
  const defaultMode = fullCase || options.controlledAcceptance ? 'STRICT' : options.researchMode ?? 'PRELIMINARY'
  const factory = options.runtimeFactory ?? fullCase?.runtime ?? createWorkbenchRuntime
  const limits = options.researchLimits ?? { queries: 40, verifications: 60, httpRequests: 60, durationMs: 300_000 }
  // ponytail: one active operation on this local server; add a durable queue only for multi-user deployment.
  let activeBudget: AcceptanceBudget | undefined, activeJob: Promise<void> | undefined
  let activeResearch: { key: string; id: string; cancelled: boolean } | undefined
  const acquire = (operationLimits = limits) => {
    if (activeBudget) throw new WorkspaceError('已有案情提取或研究进行中，请等待结束', 409)
    return activeBudget = new AcceptanceBudget(operationLimits)
  }
  app.addHook('onReady', () => workspace.recoverInterruptedResearch())
  app.addHook('onClose', async () => { activeBudget?.cancel(); fullCase?.stop(); await activeJob })
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body))
  app.addHook('onRequest', async (request, reply) => {
    const hostname = request.headers.host?.split(':')[0]
    if (!['127.0.0.1', 'localhost'].includes(hostname ?? '')) return reply.code(403).send({ error: '仅接受本地工作台访问' })
    const origin = request.headers.origin
    if (origin && origin === options.siteOrigin && !fullCase && !options.controlledAcceptance) {
      const url = new URL(request.url, 'http://localhost')
      // The retained Site operates the selected case only; import and global listing stay local.
      const read = request.method === 'GET' && (url.pathname === '/health'
        || /^\/api\/cases\/[a-zA-Z0-9-]+(?:\/research\/status|\/legal-context)?$/.test(url.pathname)
        || /^\/api\/cases\/[a-zA-Z0-9-]+\/report-versions\/[a-zA-Z0-9-]+$/.test(url.pathname) && ['user','internal'].includes(url.searchParams.get('kind')??''))
      const write = request.method === 'POST' && (url.pathname === '/api/cases' || /^\/api\/cases\/[a-zA-Z0-9-]+\/(?:research(?:\/cancel)?|facts\/confirm)$/.test(url.pathname))
      const preflight = request.method === 'OPTIONS' && ['GET', 'POST'].includes(String(request.headers['access-control-request-method']))
      if (!read && !write && !preflight) return reply.code(403).send({ error: '本站仅可操作所选案件的分析与报告' })
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
        .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type, X-Evidence-Workspace')
      if (request.headers['access-control-request-private-network'] === 'true') reply.header('Access-Control-Allow-Private-Network', 'true')
      if (preflight) return reply.code(204).send()
      if (write && request.headers['x-evidence-workspace'] !== '1') return reply.code(403).send({ error: '请通过工作台操作' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.headers['x-evidence-workspace'] !== '1' || origin && origin !== `http://${request.headers.host}`) {
        return reply.code(403).send({ error: '请通过本地材料工作台操作' })
      }
    }
  })
  app.addHook('preHandler', async (request, reply) => {
    if (options.siteOrigin && request.headers.origin === options.siteOrigin && request.method === 'POST'
      && !request.url.endsWith('/research/cancel')
      && (!request.body || typeof request.body !== 'object' || !('mode' in request.body) || !['PRELIMINARY','STRICT'].includes(String(request.body.mode)))) {
      return reply.code(403).send({ error: '请显式选择初步分析或深度研究模式' })
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    const httpCode = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined
    const status = error instanceof WorkspaceError ? error.statusCode : error instanceof AcceptanceBudgetError ? 409 : error instanceof z.ZodError ? 400
      : typeof httpCode === 'number' ? httpCode : 500
    reply.code(status).send({ error: error instanceof WorkspaceError || error instanceof AcceptanceBudgetError || error instanceof PreliminaryQualityError ? error.message : status === 400 ? '输入格式或研究数据校验失败'
      : status === 413 ? '文件或请求超过大小限制' : '操作失败，已有材料记录保留；请检查本地数据' })
  })

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8')
    return readFile(resolve(webRoot, 'index.html'), 'utf8')
  })

  app.get('/workbench.css', async (_request, reply) => {
    reply.type('text/css; charset=utf-8')
    return readFile(resolve(webRoot, 'workbench.css'), 'utf8')
  })

  app.get('/workbench.js', async (_request, reply) => {
    reply.type('text/javascript; charset=utf-8')
    return readFile(resolve(webRoot, 'workbench.js'), 'utf8')
  })

  app.get('/portfolio-demo.js', async (_request, reply) => {
    reply.type('text/javascript; charset=utf-8')
    return readFile(resolve(webRoot, 'portfolio-demo.js'), 'utf8')
  })

  app.get('/health', async () => ({ status: 'ok', mode: 'evidence-workspace', ...(options.executionMode ? { executionMode:options.executionMode } : {}) }))
  app.get('/api/controlled-acceptance', async () => fullCase ? fullCase.metadata() : options.controlledAcceptance
    ? options.controlledAcceptance.preflight(workspace, options.controlledAcceptance.plan.key) : null)
  app.get('/api/cases', async () => workspace.list())
  app.post('/api/cases/import', async request => workspace.importCase(request.body))
  app.post<{ Params: { key: string } }>('/api/cases/:key/research/import', async request => workspace.attachResearch(request.params.key, request.body))
  app.post('/api/cases', async (request, reply) => {
    if (options.controlledAcceptance) throw new WorkspaceError('受控验收仅使用已预检的 TEST DATA 隔离案；新建案会增加付费范围', 409)
    const { rawCase, mode = defaultMode } = z.strictObject({ rawCase: z.string().trim().min(1).max(20_000),
      mode: z.enum(['PRELIMINARY', 'STRICT']).optional() }).parse(request.body)
    if (fullCase && mode !== 'STRICT') throw new WorkspaceError('受控验收模式不允许改为初步分析', 409)
    if(activeBudget)throw new WorkspaceError('已有操作进行中',409)
    const budget = fullCase ? activeBudget=fullCase.acquire('CREATE',rawCase) : acquire()
    let runtime: ReturnType<WorkbenchRuntimeFactory> | undefined
    try {
      runtime = factory(budget, { mode })
      if (mode === 'PRELIMINARY' && !runtime.preliminary) throw new WorkspaceError('当前运行环境未提供初步分析能力', 503)
      const intake = mode === 'PRELIMINARY' ? await budget.run(() => runtime!.preliminary!.intake(rawCase)) : undefined
      const caseData = intake?.case ?? caseSchema.parse(await budget.run(() => runtime!.dependencies.factExtractor.extract(rawCase)))
      budget.check()
      return reply.code(201).send(await workspace.importInitialCase(rawCase, caseData, intake))
    } catch(error) { fullCase?.finish(error); throw error }
    finally { runtime?.close(); if(!fullCase)budget.dispose(); activeBudget = undefined }
  })
  app.post<{ Params: { key: string } }>('/api/cases/:key/facts/confirm', async request => {
    z.strictObject({ mode:z.literal('STRICT').optional() }).parse(request.body)
    await workspace.confirmFacts(request.params.key); return { ok: true }
  })
  app.post<{ Params: { key: string } }>('/api/cases/:key/facts', async request => workspace.changeFact(request.params.key, request.body))
  app.post<{ Params: { key: string } }>('/api/cases/:key/reports/regenerate', async request => {
    const options=z.strictObject({ mode:z.enum(['PRELIMINARY','STRICT']).optional() }).parse(request.body)
    return workspace.regenerateReport(request.params.key, options)
  })
  app.get<{ Params: { key: string; version: string }; Querystring: { format?: string; kind?: string } }>('/api/cases/:key/report-versions/:version', async (request, reply) => {
    const artifact = await workspace.reportArtifact(request.params.key, request.params.version, request.query.format ?? 'html', request.query.kind)
    const types = { html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json',
      pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    reply.type(types[artifact.format]).header('X-Content-Type-Options', 'nosniff')
    if (artifact.format === 'html') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'")
    else reply.header('Content-Disposition', `attachment; filename="${request.query.kind === 'complaint' ? 'complaint' : request.query.kind === 'internal' ? 'internal' : 'report'}-v${artifact.version.version}.${artifact.format}"`)
    return artifact.bytes
  })
  app.post<{ Params: { key: string } }>('/api/cases/:key/research', async (request, reply) => {
    const body = z.union([z.strictObject({ fresh: z.boolean().optional(), mode: z.enum(['PRELIMINARY', 'STRICT']).optional() }), z.strictObject({ mode: z.literal('SINGLE_QUESTION_ACCEPTANCE') }),z.strictObject({mode:z.literal('FULL_CASE_ACCEPTANCE')})]).parse(request.body)
    const mode = body.mode === 'PRELIMINARY' || body.mode === 'STRICT' ? body.mode : defaultMode
    const acceptance = 'mode' in body && body.mode==='SINGLE_QUESTION_ACCEPTANCE' ? options.controlledAcceptance : undefined
    if (body.mode === 'SINGLE_QUESTION_ACCEPTANCE' && !acceptance || body.mode === 'FULL_CASE_ACCEPTANCE' && !fullCase || options.controlledAcceptance && !acceptance
      || fullCase && (!('mode' in body)||body.mode!=='FULL_CASE_ACCEPTANCE')) throw new WorkspaceError('验收模式与当前工作台不匹配', 409)
    if (acceptance) {
      const preflight = await acceptance.preflight(workspace, request.params.key)
      if (preflight.used) throw new WorkspaceError('本次验收已使用；拒绝重复启动', 409)
      if (!acceptance.authorized) throw new WorkspaceError('零付费预检模式：尚未获得本次 LIVE 独立授权', 409)
    }
    if(activeBudget)throw new WorkspaceError('已有操作进行中',409)
    // Preserve material gates before consuming the one research attempt.
    if(fullCase){const view=await workspace.view(request.params.key);if(view.case.id!==fullCase.plan.caseId||view.rawCase!==fullCase.plan.rawCase)throw new WorkspaceError('本次验收只允许预检的新建案件',409);if(!view.factsConfirmed||view.evidence.items.some(e=>e.file?.confirmationStatus==='PENDING'))throw new WorkspaceError('请先核对事实并确认或排除PENDING材料',409)}
    const budget = fullCase ? activeBudget=fullCase.acquire('RESEARCH') : acquire(acceptance ? acceptance.operationLimits() : limits), id = randomUUID(), key = request.params.key
    const queryDiagnostics: QueryDomainDiagnostic[] = []
    let progress = Promise.resolve(), stage = '准备研究', progressError: unknown
    const enqueue = (work: () => Promise<unknown>) => {
      progress = progress.then(work).then(() => undefined).catch(error => { progressError ??= error; budget.cancel() })
    }
    const recordStage = (label: string) => {
      stage = label; enqueue(() => workspace.updateResearch(key, id, label))
    }
    const questionStages: Record<string, string> = { AUTHORITY_APPLICABILITY: '法源适用性', NORMATIVE_IR: '规范生成',
      RULE_RENDER: '规范校验', ENTAILMENT: '独立蕴含校验', APPLICATION: '事实对应' }
    const questionStatus = new Map<string, 'QUEUED' | 'STARTED' | 'COMPLETED' | 'BLOCKED' | 'REUSED'>()
    let runtime: ReturnType<WorkbenchRuntimeFactory> | undefined
    let snapshot: Awaited<ReturnType<EvidenceWorkspace['beginResearch']>>
    try {
      // Validate the snapshot before loading configuration or starting any provider.
      snapshot = await workspace.beginResearch(key, id, mode)
      activeResearch = { key, id, cancelled: false }
      if (acceptance) acceptance.claim(id)
      else runtime = factory(budget, {
        mode,
        // Fresh reruns deliberately bypass old responses; controlled batches keep their own audited cache.
        cacheRoot: fullCase ? undefined : resolve(workspace.root, key, 'research-cache',
          createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')),
        cacheReuse: !('fresh' in body && body.fresh),
        onModelReuse: () => enqueue(() => workspace.recordModelReuse(key, id)),
        onQuestion: (qid, status) => { questionStatus.set(qid, status); enqueue(() => workspace.updateQuestion(key, id, qid, status,
          status === 'BLOCKED' ? '校验受阻' : status === 'REUSED' ? '精确快照已重验' : status === 'COMPLETED' ? '分析已完成' : status === 'QUEUED' ? '等待执行' : '准备分析')) },
        onNormativeStage: (next, qid) => enqueue(() => workspace.updateQuestion(key, id, qid, questionStatus.get(qid) ?? 'STARTED', questionStages[next] ?? next)),
        onQueryDomainDiagnostic: diagnostic => {
        if (queryDiagnostics.length < 100) queryDiagnostics.push(diagnostic)
      } })
      if (!acceptance && mode === 'PRELIMINARY' && !runtime?.preliminary) throw new WorkspaceError('当前运行环境未提供初步分析能力', 503)
    } catch (error) {
      await workspace.updateResearch(key, id, '研究未启动', error instanceof WorkspaceError ? error.message : '研究初始化失败，请检查本地配置。').catch(() => undefined)
      runtime?.close(); fullCase?.finish(error); budget.dispose(); activeBudget = undefined; activeResearch = undefined
      throw error
    }
    const stageLabels: Record<string, string> = { Classification: '识别案件类型', 'Dispute Identification': '整理争议',
      'Legal Questions': '整理法律问题', 'Search Queries': '准备检索', Retrieval: '检索法律依据', 'Source Verification': '核验来源' }
    const workflow = acceptance || mode === 'PRELIMINARY' ? undefined : new ResearchWorkflow(budget.dependencies(runtime!.dependencies), { instrumentation: runtime!.instrumentation, onStage: event => {
      if (event.status === 'STARTED') {
        recordStage(stageLabels[event.stage] ?? '整理研究结果')
      }
    } })
    activeJob = (async () => {
      let running: Promise<unknown> | undefined
      try {
        if (acceptance) {
          await acceptance.execute(workspace, key, id, budget, recordStage)
          await progress; if (progressError) throw progressError
        } else if (mode === 'PRELIMINARY') {
          recordStage('读取证据材料')
          snapshot.evidence = await budget.run(() => workspace.preparePreliminaryMaterials(key, id, budget.signal))
          const work = runtime!.preliminary!.run({ ...snapshot, factsConfirmed: snapshot.factsConfirmed ?? false }, recordStage)
          running = work
          const result = await budget.run(() => work)
          recordStage('保存初步分析')
          await progress; if (progressError) throw progressError
          budget.check()
          await workspace.savePreliminary(key, id, result)
          recordStage('导出初步报告')
          await budget.run(() => workspace.regenerateReport(key, { signal: budget.signal, runId: id }))
          await progress; if (progressError) throw progressError
          budget.check()
          await workspace.finishPreliminary(key, id)
        } else {
          const work = workflow!.run(snapshot.rawCase, { initialCase: snapshot.case, caseEvidence: snapshot.evidence,
            onDerivedStage: (derived, output) => { if (output === undefined) recordStage(derived === 'Rule Extraction' ? '整理规则与适用' : '汇总研究结果') },
          })
          running = work
          const result = await budget.run(() => work)
          recordStage('保存研究结果')
          await progress; if (progressError) throw progressError
          budget.check()
          fullCase?.validate(result)
          await workspace.saveResearch(key, id, result, true)
          recordStage('导出深度研究报告')
          await budget.run(()=>workspace.regenerateReport(key, {mode:'STRICT',signal:budget.signal,runId:id}))
          await progress; if(progressError)throw progressError
          budget.check(); await workspace.finishResearch(key,id,'STRICT')
          if(fullCase)fullCase.finish()
        }
      } catch (error) {
        budget.cancel()
        await running?.catch(() => undefined)
        fullCase?.finish(error)
        await progress.catch(() => undefined)
        const diagnostic = safeFailureDiagnostic(error)
        await workspace.updateResearch(key, id, stage, error instanceof PreliminaryQualityError ? error.message : activeResearch?.cancelled ? '研究已取消；已完成题快照、材料及上一份报告已保留。重新启动时精确重验并复用，未完成题重新执行。' : error instanceof AcceptanceBudgetError
          ? '研究达到时间或请求预算上限；已有材料及上一份报告已保留，可重试。'
          : `${stage}失败；已有材料及上一份报告已保留。${diagnostic.failureKind === 'QUERY_BUSINESS_RULE'
            ? `查询输出未通过安全校验（${diagnostic.ruleId}），未绕过研究门槛。` : `诊断：${diagnostic.failureKind}。请检查配置或输出。`}可继续生成当前信息与行动报告。`,true)
      } finally {
        if (queryDiagnostics.length) await workspace.saveQueryDomainAudit(key, id, queryDiagnostics)
          .catch(() => app.log.error('Query audit could not be saved; check local storage'))
        runtime?.close(); budget.dispose(); activeBudget = undefined; activeResearch = undefined
      }
    })().catch(() => { app.log.error('Research state could not be saved; check local storage') })
    return reply.code(202).send({ runId: id, status: 'RUNNING' })
  })
  app.get<{ Params: { key: string } }>('/api/cases/:key/research/status', async request => {
    let researchRun = await workspace.researchStatus(request.params.key)
    if (researchRun?.status === 'RUNNING' && (!activeResearch || activeResearch.key !== request.params.key)) {
      await workspace.updateResearch(request.params.key, researchRun.id, '研究已停止', '研究状态保存失败；请检查本地存储后重试。')
      researchRun = await workspace.researchStatus(request.params.key)
    }
    return { researchRun }
  })
  app.post<{ Params: { key: string } }>('/api/cases/:key/research/cancel', async request => {
    z.strictObject({}).parse(request.body)
    if (!activeResearch || activeResearch.key !== request.params.key || !activeBudget) throw new WorkspaceError('此案件没有正在执行的研究', 409)
    activeResearch.cancelled = true
    activeBudget.cancel()
    return { ok: true }
  })
  app.get<{ Params: { key: string } }>('/api/cases/:key', async request => {
    const {mode}=z.object({mode:z.enum(['PRELIMINARY','STRICT']).optional()}).parse(request.query)
    const view = await workspace.view(request.params.key,mode)
    if (view.researchRun?.status === 'RUNNING' && !activeBudget) {
      // A failed status write must not leave the UI polling a job which no longer exists.
      await workspace.updateResearch(request.params.key, view.researchRun.id, '研究已停止', '研究状态保存失败；请检查本地存储后重试。')
      return { ...await workspace.view(request.params.key,mode), defaultResearchMode: mode??defaultMode }
    }
    return { ...view, defaultResearchMode: mode??defaultMode }
  })
  app.get<{Params:{key:string}}>('/api/cases/:key/legal-context',async(request,reply)=>{
    const {mode}=z.object({mode:z.enum(['PRELIMINARY','STRICT']).default('PRELIMINARY')}).parse(request.query)
    const view=await workspace.view(request.params.key,mode,true)
    return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'").send(view.legalContextHtml)
  })
  app.post<{ Params: { key: string } }>('/api/cases/:key/materials', async request => {
    const filename = z.string().min(1).max(2300).parse(request.headers['x-file-name'])
    let decoded: string
    try { decoded = decodeURIComponent(filename) } catch { throw new WorkspaceError('文件名编码无效') }
    if (!Buffer.isBuffer(request.body)) throw new WorkspaceError('请发送原始文件字节')
    return workspace.upload(request.params.key, decoded, request.body, String(request.headers['x-file-mime'] ?? ''))
  })
  app.post<{ Params: { key: string; id: string } }>('/api/cases/:key/materials/:id/parse', async request => {
    await workspace.parse(request.params.key, request.params.id, request.body, { readImages: defaultMode === 'PRELIMINARY' }); return { ok: true }
  })
  app.post<{ Params: { key: string; id: string } }>('/api/cases/:key/materials/:id/decision', async request => {
    await workspace.decide(request.params.key, request.params.id, request.body); return { ok: true }
  })
  app.post<{ Params: { key: string; id: string } }>('/api/cases/:key/materials/:id/reopen', async request => {
    await workspace.reopen(request.params.key, request.params.id); return { ok: true }
  })
  app.delete<{ Params: { key: string; id: string } }>('/api/cases/:key/materials/:id', async request => {
    await workspace.remove(request.params.key, request.params.id); return { ok: true }
  })
  app.get<{ Params: { key: string; id: string } }>('/api/cases/:key/materials/:id/original', async (request, reply) => {
    const file = await workspace.original(request.params.key, request.params.id)
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .header('X-Content-Type-Options', 'nosniff').type(file.mimeType)
    return file.bytes
  })
  app.get<{ Params: { key: string; kind: string }; Querystring: { format?: string } }>('/api/cases/:key/reports/:kind', async (request, reply) => {
    if (!['user', 'internal', 'action', 'detailed', 'continuation'].includes(request.params.kind)) throw new WorkspaceError('报告类型无效')
    const {mode}=z.object({mode:z.enum(['PRELIMINARY','STRICT']).optional()}).parse(request.query)
    const view = await workspace.view(request.params.key,mode), detailed = request.params.kind === 'detailed'
    if (view.preliminaryReport && ['user', 'action'].includes(request.params.kind) && !view.latestReport) {
      return request.query.format === 'md' ? reply.type('text/markdown; charset=utf-8').send(renderUserMarkdown(view.preliminaryReport, true))
        : reply.type('text/html; charset=utf-8').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'").send(renderUserHtml(view.preliminaryReport, true))
    }
    if (view.latestReport && ['user', 'action', 'internal'].includes(request.params.kind)) {
      const format = request.query.format === 'md' ? 'md' : 'html'
      const artifact = await workspace.reportArtifact(request.params.key, view.latestReport.reportVersionId, format, request.params.kind === 'internal' ? 'internal' : 'report')
      reply.type(format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8')
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'")
      return artifact.bytes
    }
    if (request.params.kind === 'internal') {
      if (!view.internalReport) throw new WorkspaceError('尚无可复用研究，请先接入成果或显式生成当前报告', 409)
      if (request.query.format === 'md') return reply.type('text/markdown; charset=utf-8').send(renderUserMarkdown(view.internalReport))
      return reply.type('text/html; charset=utf-8').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'").send(renderUserHtml(view.internalReport))
    }
    if (request.params.kind === 'continuation') {
      if (request.query.format === 'md') return reply.type('text/markdown; charset=utf-8').send(renderUserMarkdown(view.answerReport))
      return reply.type('text/html; charset=utf-8').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'")
        .send(renderUserHtml(view.answerReport))
    }
    if (request.params.kind !== 'user' && (!view.actionReport || !view.detailedReport)) throw new WorkspaceError('研究尚未完成，请先核对事实与材料并启动研究', 409)
    if (request.query.format === 'md') {
      reply.type('text/markdown; charset=utf-8')
      return detailed ? renderUserMarkdown(view.detailedReport!) : renderUserMarkdown(view.answerReport)
    }
    reply.type('text/html; charset=utf-8').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'")
    return detailed ? renderUserHtml(view.detailedReport!) : renderUserHtml(view.answerReport)
  })

  return app
}
