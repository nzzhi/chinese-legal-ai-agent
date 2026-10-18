import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { caseSchema, factCategorySchema, type Case } from '../case/caseSchema.js'
import { assessCaseEvidence, caseEvidenceInputSchema, evidenceStage, isPaymentReceived, type CaseEvidence } from './caseEvidence.js'
import { buildUserActionReport } from '../report/userActionReport.js'
import { buildUserCaseReport } from '../report/userCaseReport.js'
import { currentReportInput, readReportVersions, regenerateReport, researchReuse } from '../report/reportRegeneration.js'
import { buildUserAnswerReport } from '../report/userAnswerExperience.js'
import { buildCaseContinuationReport } from '../report/caseContinuationReport.js'
import { queryDomainAuditSchema, type QueryDomainDiagnostic } from '../legalQuery/queryDomainDiagnostic.js'
import { buildInternalResearchReport } from '../report/conditionalResearchReport.js'
import { preliminaryIntakeSchema, validatePreliminaryResult, preliminarySources, type PreliminaryIntake } from '../assistant/preliminaryWorkflow.js'
import { assessPreliminaryQuality, PreliminaryQualityError, preliminaryQualitySchema } from '../assistant/preliminaryQuality.js'
import { buildPreliminaryReport, exportPreliminaryReport } from '../report/preliminaryReport.js'
import { inputHash } from '../report/reportRegeneration.js'
import { imageText } from './imageText.js'
import { renderLegalContext } from '../workbench/legalContext.js'

export class WorkspaceError extends Error {
  constructor(message: string, readonly statusCode = 400, options?: ErrorOptions) { super(message, options) }
}
const limit = 10 * 1024 * 1024
const mimeTypes: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
const eventSchema = z.strictObject({ at: z.string().datetime(), action: z.string(), evidenceId: z.string().optional(),
  details: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())])) })
const researchRunSchema = z.strictObject({ id: z.string().uuid(), status: z.enum(['RUNNING', 'SAVED', 'FAILED']),
  mode: z.enum(['PRELIMINARY', 'STRICT']).optional(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(), stage: z.string().max(100),
  error: z.string().max(300).optional(),
  qualityStatus: preliminaryQualitySchema.shape.status.optional(),
  questions: z.array(z.strictObject({ id: z.string().min(1), status: z.enum(['QUEUED', 'STARTED', 'COMPLETED', 'BLOCKED', 'REUSED']), stage: z.string().max(100) })).max(24).optional(),
  modelReuseCount: z.number().int().nonnegative().optional() })
const stateSchema = z.strictObject({ caseId: z.string(), evidence: caseEvidenceInputSchema, events: z.array(eventSchema).max(5000),
  factsConfirmed: z.boolean().optional(), researchRun: researchRunSchema.optional(), researchRevisionId: z.string().uuid().optional(),
  preliminaryRevisionId: z.string().uuid().optional(), analysisMode: z.enum(['PRELIMINARY', 'STRICT']).optional(), currentCase: caseSchema.optional() })
type State = z.infer<typeof stateSchema>
const researchSchema = z.object({ case: caseSchema }).passthrough()
const parseRequest = z.strictObject({ text: z.string().trim().min(1).max(20_000).optional(),
  type: z.enum(['PAYMENT_RECORD', 'CHAT_RECORD', 'OTHER']).optional() })
const decisionSchema = z.strictObject({ decision: z.enum(['CONFIRMED', 'REJECTED']), contextComplete: z.boolean(),
  links: z.array(z.strictObject({ factId: z.string().min(1), quote: z.string().trim().min(1).max(20_000),
    support: z.enum(['SUPPORTED', 'PARTIAL']) })).max(100) })

/** Only explicit labels and original lines are extracted. Missing/ambiguous values stay missing. */
export function extractMaterial(text: string, requestedType?: 'PAYMENT_RECORD' | 'CHAT_RECORD' | 'OTHER') {
  const fields: Record<string, string> = {}, reviewReasons: string[] = []
  const labels: Record<string, string> = { amount: '金额', time: '时间|交易时间|付款时间|日期', transactionId: '交易单号',
    payer: '付款方', recipient: '收款方', result: '状态|交易状态', note: '备注', participants: '对话双方',
    identityNumber: '身份证号|身份证号码', address: '详细住址|住址|住所|地址', name: '姓名', account: '微信号|账号', phone: '手机号', nickname: '微信昵称', mapping: '对应关系', source: '来源' }
  for (const [key, label] of Object.entries(labels)) {
    const values = [...text.matchAll(new RegExp(`^(?:${label})[：:]\\s*(.+)$`, 'gm'))].map(m => m[1].trim())
    if (new Set(values).size === 1 && !/^(未知|不详|未提供|无|待核对)$/.test(values[0])) fields[key] = values[0].slice(0, 2000)
    else if (values.length > 1) reviewReasons.push(`${key}存在多个值，请核对`)
  }
  if (!fields.account && fields.phone && !reviewReasons.some(reason => reason.startsWith('account'))) fields.account = fields.phone
  if (fields.time) {
    const date = fields.time.match(/^(\d{4}-\d{2}-\d{2})(?:\s|$)/), parsed = date ? new Date(`${date[1]}T00:00:00Z`) : undefined
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date![1]) {
      delete fields.time; reviewReasons.push('时间未可靠提取为有效日期，请核对')
    }
  }
  if (fields.name && /昵称|网名|未知|未提供/.test(fields.name)) { delete fields.name; reviewReasons.push('只有昵称或姓名未明确，不能补齐真实姓名') }
  const type = requestedType ?? (fields.transactionId || /微信转账记录/.test(text) ? 'PAYMENT_RECORD'
    : fields.participants || /微信聊天记录/.test(text) ? 'CHAT_RECORD' : 'OTHER')
  if (type === 'PAYMENT_RECORD' && fields.amount && !/^\d+(?:\.\d{1,2})?\s*元?$/.test(fields.amount)) {
    delete fields.amount; reviewReasons.push('金额格式存在歧义')
  }
  if (type === 'CHAT_RECORD') {
    const lines = text.split(/\r?\n/).filter(line => /借|还|催/.test(line) && !/^(?:标题|材料|说明|对话双方)[：:]/.test(line))
    if (lines.length) fields.keyQuotes = lines.join('\n').slice(0, 2000)
    for (const [key, pattern] of [['borrowing', /借/], ['repaymentAgreement', /三个月后还|还款.*约定|约定.*还款/],
      ['reminder', /催|请.*还|什么时候还/], ['promise', /一定还|肯定会还|承诺.*还/]] as const) {
      const matching = lines.filter(line => pattern.test(line))
      if (matching.length) fields[key] = matching.join('\n').slice(0, 2000)
    }
  }
  const required = type === 'PAYMENT_RECORD' ? ['amount', 'time', 'transactionId', 'payer', 'recipient', 'result']
    : type === 'CHAT_RECORD' ? ['participants', 'time', 'keyQuotes'] : ['name', 'account', 'mapping', 'source']
  required.filter(key => !fields[key]).forEach(key => reviewReasons.push(`未可靠提取：${key}`))
  if (type === 'OTHER') reviewReasons.push('身份与账号对应关系须人工核对；姓名标签本身不验证身份')
  if (type === 'PAYMENT_RECORD' && fields.result && !isPaymentReceived(fields.result)) reviewReasons.push('未显示成功到账，不能建议支持交付款项')
  return { type, fields, reviewReasons, parseStatus: reviewReasons.length ? 'NEEDS_REVIEW' as const : 'PARSED' as const,
    summary: type === 'PAYMENT_RECORD' ? `转账记录：${fields.amount ?? '金额待核对'}；${fields.result ?? '状态待核对'}`
      : type === 'CHAT_RECORD' ? '聊天记录：关键原文已登记，请核对双方账号、日期及完整上下文' : '身份/账号或其他材料：需人工核对' }
}

function suggestions(item: CaseEvidence, caseData: Case) {
  if (!item.content || !item.file) return []
  const fields = item.file.fields, content = item.content
  return [...caseData.facts, ...caseData.disputedFacts].flatMap(fact => {
    let quote: string | undefined
    if (item.type === 'PAYMENT_RECORD' && fact.category === 'PAYMENT' && !/未还|利息|退回|失败/.test(fact.content)
      && isPaymentReceived(fields.result)) {
      const amount = fact.content.match(/(\d+(?:\.\d+)?)元/)?.[1]
      if ((!amount || Number(amount) === Number(fields.amount?.replace(/元$/, ''))) && /转账|借给|付款|支付/.test(fact.content)) quote = item.content
    } else if (item.type === 'CHAT_RECORD' && ['CONTRACT', 'COMMUNICATION'].includes(fact.category)) {
      const literal = fact.content.match(/“([^”]+)”/)?.[1]
      if (literal && content.includes(literal)) quote = literal
      else if (/三个月后还/.test(fact.content)) quote = content.split(/\r?\n/).find(line => line.includes('三个月后还'))
      else if (/催/.test(fact.content)) quote = fields.reminder?.split('\n')[0]
    } else if (item.type === 'OTHER' && fact.category === 'PARTY' && fields.account) quote = item.content
    if (!quote) return []
    return [{ evidenceId: item.id, factId: fact.id, quote, support: 'PARTIAL' as const,
      purpose: `建议核对材料是否支持：${fact.content}`, relationType: 'PARTIALLY_SUPPORTS' as const,
      status: 'SUGGESTED' as const, confirmedByUser: false, createdAt: new Date().toISOString() }]
  })
}

async function pdfText(bytes: Buffer): Promise<string> {
  // ponytail: 30 pages / 10 seconds; larger or scanned PDFs fall back to human transcription.
  return new Promise((resolveText, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      (async () => { const { getDocument } = await import(workerData.module);
        const task = getDocument({ data: new Uint8Array(workerData.bytes), isEvalSupported: false, useSystemFonts: false });
        try { const pdf = await task.promise; if (pdf.numPages > 30) throw new Error('PDF超过30页');
          let text = ''; for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n); const content = await page.getTextContent();
            text += content.items.map(i => i.str === undefined ? '' : i.str + (i.hasEOL ? '\\n' : ' ')).join('') + '\\n';
            if (text.length > 20000) throw new Error('PDF提取文本超过20000字'); }
          parentPort.postMessage({ text }); } finally { await task.destroy(); }
      })().catch(e => parentPort.postMessage({ error: e.message }));`,
    { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData: { bytes, module: import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs') } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('PDF解析超时')); }, 10_000)
    worker.once('message', result => { clearTimeout(timer); void worker.terminate()
      if (result.error) reject(new Error(result.error)); else resolveText(result.text) })
    worker.once('error', error => { clearTimeout(timer); void worker.terminate(); reject(error) })
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('PDF解析进程已停止，未返回内容')) })
  })
}

export class EvidenceWorkspace {
  readonly root: string
  // ponytail: one local process serializes writes; use a database transaction before supporting multiple servers.
  private pending = Promise.resolve()
  constructor(root = '.local/evidence-workspace', private readonly reportOptions: { pdfFontPath?: string } = {}) { this.root = resolve(root) }
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pending.then(operation); this.pending = run.then(() => undefined, () => undefined); return run
  }
  private folder(key: string) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new WorkspaceError('案件不存在', 404)
    return join(this.root, key)
  }
  private async load(key: string, writingMaterials = false) {
    try {
      const research = researchSchema.parse(JSON.parse(await readFile(join(this.folder(key), 'research.json'), 'utf8')))
      const state = stateSchema.parse(JSON.parse(await readFile(join(this.folder(key), 'state.json'), 'utf8')))
      if (state.caseId !== research.case.id || state.currentCase && state.currentCase.id !== state.caseId) throw new Error('Case mismatch')
      if (writingMaterials && state.researchRun?.status === 'RUNNING') throw new WorkspaceError('研究进行中，请结束后再修改事实确认或材料', 409)
      return { research, state }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceError('案件不存在', 404)
      throw error
    }
  }
  private async save(key: string, state: State) {
    stateSchema.parse(state)
    const temporary = join(this.folder(key), `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    await rename(temporary, join(this.folder(key), 'state.json'))
  }
  async importCase(input: unknown) {
    return this.mutate(async () => {
      const research = researchSchema.parse(input)
      try { buildInternalResearchReport(research) } catch { throw new WorkspaceError('研究 JSON 的 schema 或来源关联校验失败；请导入本项目完整研究结果') }
      const key = createHash('sha256').update(research.case.id).digest('hex').slice(0, 32)
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      try { await mkdir(this.folder(key), { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('该案件已导入，请选择已有案件；不会覆盖材料', 409); throw error }
      try {
        const evidence = caseEvidenceInputSchema.parse(research.caseEvidence ?? { items: [], links: [] })
        if (evidence.items.some(e => e.file)) throw new WorkspaceError('研究导入只接受既有材料登记；上传文件请使用材料入口')
        await writeFile(join(this.folder(key), 'research.json'), JSON.stringify(research), { flag: 'wx', mode: 0o600 })
        await this.save(key, { caseId: research.case.id, evidence, events: [{ at: new Date().toISOString(), action: 'IMPORT_CASE', details: {} }] })
      } catch (error) { await rm(this.folder(key), { recursive: true, force: true }); throw error }
      return { key, caseId: research.case.id }
    })
  }
  async list() {
    await this.pending
    let keys: string[]
    try { keys = await readdir(this.root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return (await Promise.all(keys.filter(key => /^[a-f0-9]{32}$/.test(key)).map(async key => {
      const { research, state } = await this.load(key)
      const currentCase = state.currentCase ?? research.case
      return { key, caseId: currentCase.id, createdAt: state.events[0]?.at ?? '', title: (/^\s*(?:【SIMULATED\b|SIMULATED\s*\/\s*DEMO ONLY(?:\s|$))/u.test(String(research.rawCase ?? '')) ? 'SIMULATED · ' : '') + currentCase.facts.concat(currentCase.disputedFacts)
        .slice(0, 3).map(f => f.content).join('；').slice(0, 65) || '待补充事实' }
    }))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
  }
  /** Initial facts must come from the production extractor; no fabricated completed research/report. */
  async importInitialCase(rawCase: string, input: unknown, intake?: PreliminaryIntake) {
    const caseData = caseSchema.parse(input)
    const text = z.string().trim().min(1).max(20_000).parse(rawCase)
    if (intake && (inputHash(preliminaryIntakeSchema.parse(intake).case) !== inputHash(caseData) || intake.rawCase !== text)) throw new WorkspaceError('检索术语与案情不一致')
    return this.mutate(async () => {
      const key = createHash('sha256').update(caseData.id).digest('hex').slice(0, 32)
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      try { await mkdir(this.folder(key), { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('该案件已导入，不会覆盖材料', 409); throw error }
      try {
        await writeFile(join(this.folder(key), 'research.json'), JSON.stringify({ rawCase: text, case: caseData }), { flag: 'wx', mode: 0o600 })
        if (intake) await writeFile(join(this.folder(key), 'intake.json'), JSON.stringify(intake), { flag: 'wx', mode: 0o600 })
        await this.save(key, { caseId: caseData.id, analysisMode:intake ? 'PRELIMINARY' : 'STRICT', evidence: { items: [], links: [] },
          events: [{ at: new Date().toISOString(), action: 'IMPORT_INITIAL_CASE', details: {} }] })
      } catch (error) { await rm(this.folder(key), { recursive: true, force: true }); throw error }
      return { key, caseId: caseData.id }
    })
  }
  /** Read the persisted bridge state without requiring completed research or generating a report. */
  async snapshot(key: string) {
    await this.pending
    const { research, state } = await this.load(key)
    const projection = currentReportInput(research, state.currentCase ?? research.case, state.evidence, state.factsConfirmed ?? false)
    return { key, case: state.currentCase ?? research.case, rawCase: research.rawCase, evidence: state.evidence,
      events: state.events, assessment: projection.assessment }
  }
  /** Local audit file only: deliberately absent from view(), reports and HTTP routes. */
  async saveQueryDomainAudit(key: string, runId: string, items: QueryDomainDiagnostic[]) {
    const audit = queryDomainAuditSchema.parse({ runId, recordedAt: new Date().toISOString(), items })
    return this.mutate(async () => {
      const { state } = await this.load(key)
      if (state.researchRun?.id !== runId) throw new WorkspaceError('查询诊断与当前研究不一致', 409)
      const folder = join(this.folder(key), 'query-diagnostics')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, `${audit.runId}.json`), JSON.stringify(audit, null, 2), { mode: 0o600 })
    })
  }
  async view(key: string, mode?: 'PRELIMINARY' | 'STRICT', details = false) {
    await this.pending
    const { research, state } = await this.load(key)
    const caseData = state.currentCase ?? research.case
    const analysisMode = mode ?? state.researchRun?.mode ?? state.analysisMode ?? (state.preliminaryRevisionId ? 'PRELIMINARY' : 'STRICT')
    const reportVersions = await readReportVersions(this.folder(key))
    const latestReport = reportVersions.filter(v => (v.mode ?? 'STRICT') === analysisMode).at(-1)
    const latestStrict = reportVersions.filter(v => v.mode !== 'PRELIMINARY').at(-1)
    const { input, assessment, researchReuseStatus } = currentReportInput(research, caseData, state.evidence, state.factsConfirmed ?? false, latestStrict, state.researchRevisionId ?? (state.researchRun?.status === 'SAVED' ? state.researchRun.id : undefined))
    const hasReport = researchReuseStatus === 'REUSABLE'
    const actionReport = hasReport ? buildUserActionReport(input, undefined, '2.1') : undefined
    const detailedReport = hasReport ? buildUserCaseReport(input) : undefined
    const internalReport = hasReport ? buildInternalResearchReport(input) : undefined
    const continuationReport = buildCaseContinuationReport({ ...input, researchStatus: actionReport
      ? internalReport?.conditionalResearch ? internalReport.conditionalResearch.acceptedCount < internalReport.conditionalResearch.questionCount ? 'INDETERMINATE' : 'COMPLETE'
        : actionReport.continuation!.researchStatus === 'COMPLETE' ? 'COMPLETE' : 'INDETERMINATE' : input.researchStatus })
    const answerReport = buildUserAnswerReport(input, continuationReport.continuation, undefined, actionReport)
    const preliminary = analysisMode === 'PRELIMINARY' && state.preliminaryRevisionId ? validatePreliminaryResult(JSON.parse(await readFile(
      join(this.folder(key), 'preliminary', `${state.preliminaryRevisionId}.json`), 'utf8'))) : undefined
    const preliminaryNeedsRefresh = !!preliminary && (inputHash(preliminary.case) !== inputHash(caseData)
      || inputHash(preliminary.caseEvidence) !== inputHash(state.evidence) || preliminary.factsConfirmed !== (state.factsConfirmed ?? false))
    return { key, analysisMode, case: caseData, rawCase: research.rawCase, evidence: state.evidence, answerReport,
      assessment, actionReport, detailedReport, internalReport, conditionalResearch: internalReport?.conditionalResearch,
      continuation: continuationReport.continuation, continuationReport,
      events: state.events, factsConfirmed: state.factsConfirmed ?? false,
      researchRun: !state.researchRun?.mode || state.researchRun.mode === analysisMode ? state.researchRun : undefined,
      researchReuseStatus, researchNeedsRefresh: analysisMode === 'STRICT' && researchReuseStatus === 'STALE',
      latestReport, reportVersions,
      preliminary: preliminaryNeedsRefresh ? undefined : preliminary,
      preliminaryReport: preliminary && !preliminaryNeedsRefresh ? buildPreliminaryReport(preliminary) : undefined, preliminaryNeedsRefresh,
      legalContextHtml: details ? renderLegalContext({ case:caseData, evidence:state.evidence,
        preliminary:preliminaryNeedsRefresh ? undefined : preliminary, research, mode:analysisMode,
        conditionalResearch:internalReport?.conditionalResearch, internalReport }) : undefined,
      materialLabels: Object.fromEntries(state.evidence.items.map(e => [e.id, evidenceStage(e)])) }
  }
  async regenerateReport(key: string, options: { signal?: AbortSignal; runId?: string; mode?: 'PRELIMINARY' | 'STRICT' } = {}) {
    return this.mutate(async () => {
      const { research, state } = await this.load(key, !options.runId)
      if (options.runId && (state.researchRun?.id !== options.runId || state.researchRun.status !== 'RUNNING')) throw new WorkspaceError('分析已结束，拒绝过期导出', 409)
      const mode = options.mode ?? state.analysisMode ?? (state.preliminaryRevisionId ? 'PRELIMINARY' : 'STRICT')
      if (mode === 'PRELIMINARY') {
        if (!state.preliminaryRevisionId) throw new WorkspaceError('尚无初步分析，请先启动所选模式', 409)
        const result = validatePreliminaryResult(JSON.parse(await readFile(join(this.folder(key), 'preliminary', `${state.preliminaryRevisionId}.json`), 'utf8')))
        if (inputHash(result.case) !== inputHash(state.currentCase ?? research.case) || inputHash(result.caseEvidence) !== inputHash(state.evidence)
          || result.factsConfirmed !== (state.factsConfirmed ?? false)) throw new WorkspaceError('案情或材料已更新，请重新生成初步分析；旧报告保留', 409)
        return exportPreliminaryReport(this.folder(key), key, result, state.preliminaryRevisionId, { ...this.reportOptions, ...options })
      }
      try { return await regenerateReport(this.folder(key), key, { research, case: state.currentCase ?? research.case,
        evidence: state.evidence, factsConfirmed: state.factsConfirmed ?? false, researchRunId: state.researchRevisionId ?? (state.researchRun?.status === 'SAVED' ? state.researchRun.id : undefined) }, this.reportOptions) }
      catch(cause) { throw new WorkspaceError('报告完整导出失败；旧最新版已保留，请检查中文字体配置与本地存储后重试', 500, {cause}) }
    })
  }
  async reportArtifact(key: string, versionId: string, format: string, kind = 'report') {
    await this.pending
    const versions = await readReportVersions(this.folder(key))
    const version = versionId === 'latest' ? versions.at(-1) : versions.find(v => v.reportVersionId === versionId)
    if (!version) throw new WorkspaceError('报告版本不存在', 404)
    const ext = z.enum(['json', 'html', 'md', 'docx', 'pdf']).parse(format)
    if (!['report', 'user', 'internal', 'complaint'].includes(kind)) throw new WorkspaceError('报告类型无效')
    const artifacts = kind === 'complaint' ? version.complaintArtifacts : kind === 'internal' ? version.internalArtifacts : version.artifacts
    if (!artifacts) throw new WorkspaceError('此版本没有所选报告或准备草稿，请显式重新生成报告', 409)
    return { bytes: await readFile(join(this.folder(key), artifacts[ext])), version, format: ext }
  }
  /** Explicit current facts stay separate from the historical research graph. */
  async changeFact(key: string, input: unknown) {
    const request = z.discriminatedUnion('operation', [
      z.strictObject({ operation: z.literal('ADD'), content: z.string().trim().min(1).max(20000), category: factCategorySchema }),
      z.strictObject({ operation: z.literal('UPDATE'), factId: z.string().min(1), content: z.string().trim().min(1).max(20000), category: factCategorySchema }),
      z.strictObject({ operation: z.literal('DELETE'), factId: z.string().min(1) }),
    ]).parse(input)
    return this.mutate(async () => {
      const { research, state } = await this.load(key, true)
      const current = structuredClone(state.currentCase ?? research.case)
      const fact = request.operation === 'ADD' ? undefined : current.facts.concat(current.disputedFacts).find(f => f.id === request.factId)
      if (request.operation !== 'ADD' && !fact) throw new WorkspaceError('事实不存在', 404)
      const factId = request.operation === 'ADD' ? randomUUID() : request.factId
      if (request.operation === 'ADD') current.facts.push({ id: factId, content: request.content,
        category: request.category, source: 'USER_INPUT', certainty: 'USER_CLAIM' })
      else if (request.operation === 'UPDATE') {
        fact!.content = request.content; fact!.category = request.category
        if (fact!.certainty !== 'DISPUTED') fact!.certainty = 'USER_CLAIM'
      } else {
        current.facts = current.facts.filter(f => f.id !== factId); current.disputedFacts = current.disputedFacts.filter(f => f.id !== factId)
        current.events = current.events.map(e => ({ ...e, relatedFactIds: e.relatedFactIds.filter(id => id !== factId) }))
      }
      // A previous human review binds to the old statement; require a new review after editing it.
      const oldLinks = state.evidence.links.filter(l => l.factId === factId)
      if (request.operation === 'DELETE') {
        state.evidence.links = state.evidence.links.filter(l => l.factId !== factId)
        state.evidence.items = state.evidence.items.map(e => ({ ...e, relatedFactIds: e.relatedFactIds.filter(id => id !== factId) }))
      } else if (request.operation === 'UPDATE') {
        state.evidence.links = state.evidence.links.map(l => l.factId === factId
          ? { ...l, status: 'SUGGESTED', confirmedByUser: false, review: undefined } : l)
      }
      state.currentCase = caseSchema.parse(current); state.factsConfirmed = false
      currentReportInput(research, state.currentCase, state.evidence, false)
      state.events.push({ at: new Date().toISOString(), action: 'CHANGE_FACT', details: { operation: request.operation,
        factId, previousLinks: oldLinks.map(l => JSON.stringify(l)) } })
      await this.save(key, state)
      return { factId, researchReuseStatus: researchReuse(research, current) }
    })
  }

  async confirmFacts(key: string) {
    return this.mutate(async () => {
      const { state } = await this.load(key, true)
      state.factsConfirmed = true
      state.events.push({ at: new Date().toISOString(), action: 'CONFIRM_FACTS', details: {} })
      await this.save(key, state)
    })
  }
  async beginResearch(key: string, id: string, mode: 'STRICT' | 'PRELIMINARY' = 'STRICT') {
    return this.mutate(async () => {
      const { research, state } = await this.load(key, true)
      if (mode === 'STRICT' && !state.factsConfirmed) throw new WorkspaceError('请先核对并确认提取的事实', 409)
      if (mode === 'STRICT' && state.evidence.items.some(e => e.file?.confirmationStatus === 'PENDING')) throw new WorkspaceError('请先确认或排除所有待核对材料', 409)
      const rawCase = z.string().min(1).max(20_000).refine(text => Boolean(text.trim())).safeParse(research.rawCase)
      if (!rawCase.success) throw new WorkspaceError('此导入结果缺少原始案情，请新建案件后研究', 409)
      let intake: PreliminaryIntake | undefined
      if (mode === 'PRELIMINARY') {
        try {
          const saved = preliminaryIntakeSchema.parse(JSON.parse(await readFile(join(this.folder(key), 'intake.json'), 'utf8')))
          if (saved.rawCase === rawCase.data && inputHash(saved.case) === inputHash(state.currentCase ?? research.case)) intake = saved
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      state.researchRun = researchRunSchema.parse({ id, mode, status: 'RUNNING', startedAt: new Date().toISOString(), stage: '准备研究' })
      state.events.push({ at: state.researchRun.startedAt, action: 'START_RESEARCH', details: { runId: id } })
      await this.save(key, state)
      return { rawCase: rawCase.data, case: state.currentCase ?? research.case, evidence: state.evidence,
        ...(mode === 'PRELIMINARY' ? { factsConfirmed: state.factsConfirmed ?? false, intake } : {}) }
    })
  }
  async updateResearch(key: string, id: string, stage: string, error?: string, allowSavedFailure = false) {
    return this.mutate(async () => {
      const { state } = await this.load(key)
      if (state.researchRun?.id !== id || state.researchRun.status !== 'RUNNING'
        && !(allowSavedFailure && error && state.researchRun.status === 'SAVED')) return
      state.researchRun.stage = stage
      if (error) {
        state.researchRun.status = 'FAILED'; state.researchRun.error = error
        state.researchRun.finishedAt = new Date().toISOString()
        state.events.push({ at: state.researchRun.finishedAt, action: 'RESEARCH_FAILED', details: { runId: id } })
      }
      await this.save(key, state)
    })
  }
  /** Lightweight polling avoids rebuilding both reports on every progress read. */
  async researchStatus(key: string) {
    await this.pending
    try {
      return stateSchema.parse(JSON.parse(await readFile(join(this.folder(key), 'state.json'), 'utf8'))).researchRun
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceError('案件不存在', 404)
      throw error
    }
  }
  async updateQuestion(key: string, runId: string, id: string, status: 'QUEUED' | 'STARTED' | 'COMPLETED' | 'BLOCKED' | 'REUSED', stage: string) {
    return this.mutate(async () => {
      const { state } = await this.load(key)
      if (state.researchRun?.id !== runId || state.researchRun.status !== 'RUNNING') return
      const questions = state.researchRun.questions ??= []
      const existing = questions.find(q => q.id === id)
      if (existing) Object.assign(existing, { status, stage }); else questions.push({ id, status, stage })
      await this.save(key, state)
    })
  }
  async recordModelReuse(key: string, runId: string) {
    return this.mutate(async () => {
      const { state } = await this.load(key)
      if (state.researchRun?.id !== runId || state.researchRun.status !== 'RUNNING') return
      state.researchRun.modelReuseCount = (state.researchRun.modelReuseCount ?? 0) + 1
      await this.save(key, state)
    })
  }
  async saveResearch(key: string, id: string, input: unknown, exportPending = false) {
    return this.mutate(async () => {
      const { research: previous, state } = await this.load(key)
      if (state.researchRun?.id !== id || state.researchRun.status !== 'RUNNING') throw new WorkspaceError('研究已结束，拒绝过期结果', 409)
      const result = researchSchema.parse(input)
      if (!isDeepStrictEqual(state.currentCase ?? previous.case, result.case) || previous.rawCase !== result.rawCase
        || !isDeepStrictEqual(state.evidence, caseEvidenceInputSchema.parse(result.caseEvidence))) throw new WorkspaceError('研究结果与已确认案件或材料不一致，未覆盖结果', 409)
      buildInternalResearchReport(result); buildUserActionReport(result, undefined, '2.1'); buildUserAnswerReport(result)
      const temporary = join(this.folder(key), `${randomUUID()}.tmp`)
      await mkdir(join(this.folder(key), 'research-history'), { recursive:true })
      await writeFile(join(this.folder(key), 'research-history', `${id}.json`), JSON.stringify(result), { flag:'wx', mode:0o600 })
      await writeFile(temporary, JSON.stringify(result, null, 2), { mode: 0o600 })
      await rename(temporary, join(this.folder(key), 'research.json'))
      state.researchRun.status = exportPending ? 'RUNNING' : 'SAVED'; state.researchRun.stage = exportPending ? '研究结果已保存，准备导出' : '研究结果已保存'
      state.researchRevisionId = id
      state.analysisMode = 'STRICT'
      if (!exportPending) state.researchRun.finishedAt = new Date().toISOString()
      state.events.push({ at: new Date().toISOString(), action: 'SAVE_RESEARCH', details: { runId: id } })
      await this.save(key, state)
    })
  }
  /** Separate append-only results leave research.json and every historical report intact. */
  async savePreliminary(key: string, id: string, input: unknown) {
    return this.mutate(async () => {
      const { research, state } = await this.load(key)
      if (state.researchRun?.id !== id || state.researchRun.status !== 'RUNNING') throw new WorkspaceError('分析已结束，拒绝过期结果', 409)
      const parsed = validatePreliminaryResult(input)
      const result = { ...parsed, quality: assessPreliminaryQuality(parsed, preliminarySources(parsed)) }
      if (inputHash(state.currentCase ?? research.case) !== inputHash(result.case) || research.rawCase !== result.rawCase
        || inputHash(state.evidence) !== inputHash(result.caseEvidence) || result.factsConfirmed !== (state.factsConfirmed ?? false)) {
        throw new WorkspaceError('分析结果与当前案情或材料不一致', 409)
      }
      const folder = join(this.folder(key), 'preliminary')
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await writeFile(join(folder, `${id}.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
      state.researchRun.qualityStatus = result.quality.status
      if (result.quality.status === 'BLOCKED') {
        state.events.push({ at: new Date().toISOString(), action: 'REJECT_PRELIMINARY_QUALITY',
          details: { runId: id, codes: result.quality.issues.filter(i => i.severity === 'ERROR').map(i => i.code) } })
        await this.save(key, state)
        throw new PreliminaryQualityError(result.quality)
      }
      state.preliminaryRevisionId = id
      state.analysisMode = 'PRELIMINARY'
      state.researchRun.stage = '初步分析已保存，准备导出'
      state.events.push({ at: new Date().toISOString(), action: 'SAVE_PRELIMINARY', details: { runId: id, quality: result.quality.status } })
      await this.save(key, state)
    })
  }
  async finishPreliminary(key: string, id: string) {
    return this.finishResearch(key,id,'PRELIMINARY')
  }
  async finishResearch(key:string,id:string,mode:'PRELIMINARY'|'STRICT') {
    return this.mutate(async () => {
      const { state } = await this.load(key)
      if (state.researchRun?.id !== id || state.researchRun.status !== 'RUNNING'
        || (mode==='PRELIMINARY'?state.preliminaryRevisionId:state.researchRevisionId) !== id) throw new WorkspaceError('分析已结束，拒绝过期状态', 409)
      state.researchRun.status = 'SAVED'; state.researchRun.stage = mode==='PRELIMINARY'?'初步分析与报告导出已完成':'深度研究与报告导出已完成'
      state.researchRun.finishedAt = new Date().toISOString()
      await this.save(key, state)
    })
  }
  /** Attach completed/partial research to the exact existing snapshot without running or confirming anything. */
  async attachResearch(key: string, input: unknown) {
    return this.mutate(async () => {
      const { research: previous, state } = await this.load(key, true)
      const result = researchSchema.parse(input)
      if (!isDeepStrictEqual(state.currentCase ?? previous.case, result.case) || result.rawCase !== previous.rawCase
        || !isDeepStrictEqual(state.evidence, caseEvidenceInputSchema.parse(result.caseEvidence))) {
        throw new WorkspaceError('研究成果与当前案件或材料快照不一致，拒绝接入；不会重映射事实或覆盖材料', 409)
      }
      try { buildInternalResearchReport(result); buildUserAnswerReport(result) }
      catch { throw new WorkspaceError('研究成果未通过来源、规范、蕴含或事实关联校验') }
      if (isDeepStrictEqual(previous, result)) return { ok: true, unchanged: true }
      const revisionId = randomUUID(), folder = this.folder(key), archive = join(folder, 'research-history')
      await mkdir(archive, { recursive: true, mode: 0o700 })
      await writeFile(join(archive, `${revisionId}.json`), JSON.stringify(previous, null, 2), { flag: 'wx', mode: 0o600 })
      const temporary = join(folder, `${revisionId}.tmp`)
      await writeFile(temporary, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
      await rename(temporary, join(folder, 'research.json'))
      state.researchRevisionId = revisionId
      state.analysisMode = 'STRICT'
      state.events.push({ at: new Date().toISOString(), action: 'ATTACH_RESEARCH', details: { revisionId } })
      await this.save(key, state)
      return { ok: true, unchanged: false }
    })
  }
  /** A stopped process cannot resume model work; retain materials and any atomically saved result. */
  async recoverInterruptedResearch() {
    for (const item of await this.list()) {
      const { state } = await this.load(item.key)
      if (state.researchRun?.status === 'RUNNING') await this.updateResearch(item.key, state.researchRun.id,
        '研究已中断', '服务重启中断了研究；材料已保留，请重新启动研究。')
    }
  }
  async upload(key: string, filename: string, bytes: Buffer, claimedMime: string) {
    return this.mutate(async () => {
      const { state } = await this.load(key, true), extension = extname(filename).toLowerCase(), mimeType = mimeTypes[extension]
      if (!mimeType || basename(filename) !== filename || /[\\/\x00-\x1f]/.test(filename) || filename.length > 255) throw new WorkspaceError('只支持 PNG/JPG/JPEG/PDF/TXT/MD；文件名不能包含路径')
      if (!bytes.length || bytes.length > limit) throw new WorkspaceError('文件不能为空且最大10MB', 413)
      if (claimedMime && claimedMime !== 'application/octet-stream' && claimedMime !== mimeType
        && !(extension === '.md' && claimedMime === 'text/plain')) throw new WorkspaceError('文件类型与扩展名不一致')
      if (extension === '.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-'
        || extension === '.png' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || ['.jpg', '.jpeg'].includes(extension) && !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) throw new WorkspaceError('文件签名与类型不一致')
      if (state.evidence.items.length >= 100) throw new WorkspaceError('每案件最多100份材料')
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (state.evidence.items.some(e => e.file?.hash === hash)) throw new WorkspaceError('该文件已上传，无需重复导入', 409)
      const id = randomUUID(), now = new Date().toISOString(), reference = `${id}.bin`
      const item: CaseEvidence = { id, type: 'OTHER', title: filename, source: 'FILE_REFERENCE', sourceReference: reference, relatedFactIds: [],
        file: { caseId: state.caseId, filename, mimeType, fileSize: bytes.length, sourceType: 'USER_UPLOAD', uploadedAt: now,
          parseStatus: 'UPLOADED', confirmationStatus: 'PENDING', hash, fields: {}, reviewReasons: [], contextComplete: false } }
      await writeFile(join(this.folder(key), reference), bytes, { flag: 'wx', mode: 0o600 })
      state.evidence.items.push(item); state.events.push({ at: now, action: 'UPLOAD', evidenceId: id, details: { hash, filename } })
      try { await this.save(key, state) } catch (error) { await rm(join(this.folder(key), reference), { force: true }); throw error }
      return { evidenceId: id }
    })
  }
  /** Initial reports read pending uploads once; failed extraction stays an explicit gap, not a retry loop. */
  async preparePreliminaryMaterials(key: string, runId: string, signal?: AbortSignal) {
    // Keep these reads in the write queue: Windows can reject atomic rename while state.json is open.
    const { state } = await this.mutate(() => this.load(key))
    for (const item of state.evidence.items.filter(e => e.file?.parseStatus === 'UPLOADED' && e.file.confirmationStatus === 'PENDING')) {
      signal?.throwIfAborted()
      await this.parse(key, item.id, {}, { readImages: true, signal, runId })
    }
    return (await this.mutate(() => this.load(key))).state.evidence
  }
  async parse(key: string, id: string, input: unknown, options: { readImages?: boolean; signal?: AbortSignal; runId?: string } = {}) {
    const request = parseRequest.parse(input)
    return this.mutate(async () => {
      options.signal?.throwIfAborted()
      const { research, state } = await this.load(key, !options.runId), item = state.evidence.items.find(e => e.id === id && e.file)
      if (options.runId && (state.researchRun?.id !== options.runId || state.researchRun.status !== 'RUNNING')) throw new WorkspaceError('分析已结束，停止读取材料', 409)
      if (!item?.file) throw new WorkspaceError('材料不存在', 404)
      if (item.file.confirmationStatus !== 'PENDING') throw new WorkspaceError('已确认或已拒绝材料不能重新解析；请先撤销确认', 409)
      const bytes = await readFile(join(this.folder(key), `${item.id}.bin`))
      if (createHash('sha256').update(bytes).digest('hex') !== item.file.hash) throw new WorkspaceError('原文件哈希不一致，请重新上传', 409)
      let text = request.text
      item.file.extractionMethod = text ? 'MANUAL_TRANSCRIPTION' : item.file.mimeType === 'application/pdf' ? 'PDF_TEXT'
        : item.file.mimeType.startsWith('text/') ? 'TEXT' : options.readImages ? 'LOCAL_OCR' : undefined
      let errorReason: string | undefined
      if (!text) {
        try {
          if (item.file.mimeType.startsWith('image/') && !options.readImages) throw new Error('图片已保存；v1不自动OCR，请对照原图登记原文')
          text = item.file.mimeType.startsWith('image/') ? await imageText(join(this.folder(key), `${item.id}.bin`), options.signal)
            : item.file.mimeType === 'application/pdf' ? await pdfText(bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          if (text.length > 20_000 || !text.trim() || text.includes('\0')) throw new Error('文本为空、非UTF-8或超过20000字；请人工核对登记')
        } catch (error) { options.signal?.throwIfAborted(); text = undefined; errorReason = error instanceof Error ? error.message : '内容提取失败' }
      }
      options.signal?.throwIfAborted()
      if (text) {
        item.content = text.trim(); item.source = 'PROVIDED_TEXT'
        const extracted = extractMaterial(item.content, request.type)
        const { type, ...details } = extracted
        item.type = type; Object.assign(item.file, details)
        if (item.file.extractionMethod === 'MANUAL_TRANSCRIPTION') { item.file.parseStatus = 'NEEDS_REVIEW'; item.file.reviewReasons.push('人工登记原文，需对照原件确认') }
        if (item.file.extractionMethod === 'LOCAL_OCR') { item.file.parseStatus = 'NEEDS_REVIEW'; item.file.reviewReasons.push('图片文字已识别；请核对金额、日期和姓名，识别不证明图片真实性') }
      } else {
        delete item.content; item.source = 'FILE_REFERENCE'; item.file.parseStatus = 'NEEDS_REVIEW'
        item.file.fields = {}; item.file.reviewReasons = [errorReason ?? '无法可靠提取内容']; item.file.summary = '原文件已保存，内容需要人工核对'
      }
      state.evidence.links = state.evidence.links.filter(l => l.evidenceId !== id)
      const proposed = suggestions(item, state.currentCase ?? research.case)
      state.evidence.links.push(...proposed); item.relatedFactIds = proposed.map(l => l.factId)
      state.events.push({ at: new Date().toISOString(), action: 'PARSE', evidenceId: id,
        details: { status: item.file.parseStatus, method: item.file.extractionMethod ?? 'NONE', fields: JSON.stringify(item.file.fields),
          contentHash: createHash('sha256').update(item.content ?? '').digest('hex'), suggestedFactIds: item.relatedFactIds } })
      currentReportInput(research, state.currentCase ?? research.case, state.evidence, state.factsConfirmed ?? false)
      await this.save(key, state)
    })
  }
  async decide(key: string, id: string, input: unknown) {
    const decision = decisionSchema.parse(input)
    return this.mutate(async () => {
      const { research, state } = await this.load(key, true), item = state.evidence.items.find(e => e.id === id && e.file)
      if (!item?.file) throw new WorkspaceError('材料不存在', 404)
      if (item.file.confirmationStatus !== 'PENDING') throw new WorkspaceError('请先撤销已有确认或拒绝，再修改记录', 409)
      if (decision.decision === 'CONFIRMED' && (!item.content || item.file.parseStatus === 'UPLOADED')) throw new WorkspaceError('尚无可核对原文，不能确认')
      if (decision.links.some(l => !(state.currentCase ?? research.case).facts.concat((state.currentCase ?? research.case).disputedFacts).some(f => f.id === l.factId))) throw new WorkspaceError('关联事实不存在')
      if (new Set(decision.links.map(l => l.factId)).size !== decision.links.length) throw new WorkspaceError('事实关联重复')
      const now = new Date().toISOString()
      const previous = state.evidence.links.filter(l => l.evidenceId === id)
      state.evidence.links = state.evidence.links.filter(l => l.evidenceId !== id)
      item.file.confirmationStatus = decision.decision; item.file.contextComplete = decision.contextComplete
      if (decision.decision === 'CONFIRMED') item.file.confirmedAt = now
      else delete item.file.confirmedAt
      const selected = decision.decision === 'CONFIRMED' ? decision.links : []
      item.relatedFactIds = [...new Set([...previous.map(l => l.factId), ...selected.map(l => l.factId)])]
      state.evidence.links.push(...previous.filter(l => !selected.some(s => s.factId === l.factId)).map(l => ({ ...l, status: 'CANCELLED' as const, confirmedByUser: false, review: undefined })))
      for (const link of selected) {
        if (!item.content?.includes(link.quote)) throw new WorkspaceError('关联原文必须来自材料内容')
        if (item.type === 'PAYMENT_RECORD' && !isPaymentReceived(item.file.fields.result)
          && link.support === 'SUPPORTED') throw new WorkspaceError('未显示成功到账的记录只能登记部分支持')
        state.evidence.links.push({ ...link, evidenceId: id, purpose: '用户确认材料原文与该事实的内容关联；不判断真实性',
          relationType: link.support === 'SUPPORTED' ? 'SUPPORTS' : 'PARTIALLY_SUPPORTS', status: 'CONFIRMED', confirmedByUser: true,
          createdAt: previous.find(l => l.factId === link.factId)?.createdAt ?? now,
          review: { method: 'HUMAN_CONTENT_REVIEW', reviewerId: 'local-user', reviewedAt: now, reason: '用户在材料工作台核对原文并确认关联' } })
      }
      currentReportInput(research, state.currentCase ?? research.case, state.evidence, state.factsConfirmed ?? false)
      state.events.push({ at: now, action: decision.decision, evidenceId: id, details: { contextComplete: decision.contextComplete,
        factIds: selected.map(l => l.factId), links: selected.map(l => JSON.stringify(l)) } })
      await this.save(key, state)
    })
  }
  async reopen(key: string, id: string) {
    return this.mutate(async () => {
      const { state } = await this.load(key, true), item = state.evidence.items.find(e => e.id === id && e.file)
      if (!item?.file) throw new WorkspaceError('材料不存在', 404)
      item.file.confirmationStatus = 'PENDING'; item.file.contextComplete = false; delete item.file.confirmedAt
      state.evidence.links = state.evidence.links.map(l => l.evidenceId === id ? { ...l, status: 'SUGGESTED', confirmedByUser: false, review: undefined } : l)
      state.events.push({ at: new Date().toISOString(), action: 'REOPEN', evidenceId: id, details: {} }); await this.save(key, state)
    })
  }
  async remove(key: string, id: string) {
    return this.mutate(async () => {
      const { state } = await this.load(key, true), item = state.evidence.items.find(e => e.id === id && e.file)
      if (!item?.file) throw new WorkspaceError('材料不存在', 404)
      state.evidence.items = state.evidence.items.filter(e => e.id !== id); state.evidence.links = state.evidence.links.filter(l => l.evidenceId !== id)
      state.events.push({ at: new Date().toISOString(), action: 'DELETE', evidenceId: id, details: { hash: item.file.hash } })
      await this.save(key, state); await rm(join(this.folder(key), `${item.id}.bin`), { force: true })
    })
  }
  async original(key: string, id: string) {
    await this.pending
    const { state } = await this.load(key), item = state.evidence.items.find(e => e.id === id && e.file)
    if (!item?.file) throw new WorkspaceError('材料不存在', 404)
    const bytes = await readFile(join(this.folder(key), `${item.id}.bin`))
    if (createHash('sha256').update(bytes).digest('hex') !== item.file.hash) throw new WorkspaceError('原文件哈希不一致', 409)
    return { bytes, mimeType: item.file.mimeType, filename: item.file.filename }
  }
}
