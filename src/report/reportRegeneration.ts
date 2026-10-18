import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { caseSchema, type Case } from '../case/caseSchema.js'
import { assessCaseEvidence, caseEvidenceInputSchema, evidenceStage } from '../caseEvidence/caseEvidence.js'
import { buildUserAnswerReport } from './userAnswerExperience.js'
import { buildReport } from './reportBuilder.js'
import { buildUserActionReport } from './userActionReport.js'
import { buildCaseContinuationReport } from './caseContinuationReport.js'
import { renderUserHtml, renderUserMarkdown, type PrintableReport } from './userCaseReport.js'
import { renderDocx } from './docxExporter.js'
import { renderPdf } from './pdfExporter.js'
import { buildInternalResearchReport, validatedConditionalResearch } from './conditionalResearchReport.js'

const stateLabels: Record<string, string> = { NOT_STARTED: '尚未研究', PARTIAL: '部分完成、待核验', COMPLETE: '已完成现有问题研究',
  READY: '准备信息已齐备（仍须核验）', NEEDS_INFORMATION: '尚需补充信息', BLOCKED: '该项暂不可用', MISSING: '尚缺材料' }

export const inputHash = (value: unknown): string => {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export const reuseSchema = z.enum(['REUSABLE', 'STALE', 'NOT_AVAILABLE'])
export type ResearchReuseStatus = z.infer<typeof reuseSchema>
const complaintArtifactSchema = z.string().regex(/^reports\/v\d+-[a-f0-9-]{36}\/complaint\.(json|html|md|docx|pdf)$/)
const artifactSchema = z.string().regex(/^reports\/v\d+-[a-f0-9-]{36}\/report\.(json|html|md|docx|pdf)$/)
const internalArtifactSchema = z.string().regex(/^reports\/v\d+-[a-f0-9-]{36}\/internal\.(json|html|md|docx|pdf)$/)
export const reportSnapshotSchema = z.strictObject({
  mode: z.literal('PRELIMINARY').optional(),
  reportVersionId: z.string().regex(/^v\d+-[a-f0-9-]{36}$/), version: z.number().int().positive(),
  caseId: z.string(), caseKey: z.string().regex(/^[a-f0-9]{32}$/), generatedAt: z.string().datetime(),
  caseInputHash: z.string().length(64), evidenceInputHash: z.string().length(64), researchGraphHash: z.string().length(64).optional(),
  researchReuseStatus: reuseSchema, researchNeedsRefresh: z.boolean(),
  researchStatus: z.enum(['NOT_STARTED', 'PARTIAL', 'COMPLETE']), workflowStatus: z.enum(['READY', 'PARTIAL']),
  filingReadiness: z.enum(['READY', 'NEEDS_INFORMATION', 'BLOCKED']), evidenceReadiness: z.enum(['READY', 'PARTIAL', 'MISSING']),
  artifacts: z.strictObject({ json: artifactSchema, html: artifactSchema, md: artifactSchema, docx: artifactSchema, pdf: artifactSchema }),
  internalArtifacts: z.strictObject({ json: internalArtifactSchema, html: internalArtifactSchema, md: internalArtifactSchema, docx: internalArtifactSchema, pdf: internalArtifactSchema }).optional(),
  complaintArtifacts: z.strictObject({ json: complaintArtifactSchema, html: complaintArtifactSchema, md: complaintArtifactSchema, docx: complaintArtifactSchema, pdf: complaintArtifactSchema }).optional(),
  complaintStatus: z.enum(['AVAILABLE', 'AVAILABLE_WITH_PLACEHOLDERS', 'NOT_APPROPRIATE']).optional(),
  previousVersionId: z.string().optional(), researchRunId: z.string().uuid().optional(),
  sourceReferences: z.array(z.string()),
  materials: z.array(z.strictObject({ id: z.string(), title: z.string(), stage: z.string(), hash: z.string(), linkHash: z.string().length(64).optional() })),
  gaps: z.array(z.strictObject({ id: z.string(), title: z.string(), disposition: z.string(), origin: z.enum(['RESEARCH', 'CURRENT']).optional(), factIds: z.array(z.string()).optional() })),
  changes: z.array(z.string()),
})
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>
const indexSchema = z.array(reportSnapshotSchema)

export function researchGraphHash(research: Record<string, unknown>): string {
  const { case: _case, caseEvidence: _evidence, rawCase: _raw, ...graph } = research
  return inputHash(graph)
}

/** All Case changes are conservative in v1, including new facts outside known reference ranges. */
export function researchReuse(research: unknown, currentCase: unknown, previous?: ReportSnapshot, researchRunId?: string): ResearchReuseStatus {
  const source = z.object({ case: caseSchema, legalQuestions: z.unknown().optional() }).passthrough().parse(research)
  const current = caseSchema.parse(currentCase)
  if (source.legalQuestions === undefined) return 'NOT_AVAILABLE'
  if (previous?.researchGraphHash && previous.researchGraphHash !== researchGraphHash(source)
    && previous.researchRunId === researchRunId) return 'STALE'
  if (inputHash(source.case) !== inputHash(current)) return 'STALE'
  try { buildReport(source); validatedConditionalResearch(source); return 'REUSABLE' } catch { return 'STALE' }
}

/** Validated, disposable projection; no changes to Fact certainty or Application status. */
export function currentReportInput(research: Record<string, unknown> & { case: Case }, currentCase: Case,
  evidence: unknown, factsConfirmed: boolean, previous?: ReportSnapshot, researchRunId?: string) {
  let researchReuseStatus = researchReuse(research, currentCase, previous, researchRunId)
  const caseEvidence = caseEvidenceInputSchema.parse(evidence)
  // Normative Application binds material state as well as Fact IDs; legacy quotation graphs remain reusable.
  if (researchReuseStatus === 'REUSABLE' && research.conditionalAnalysis !== undefined
    && inputHash(caseEvidenceInputSchema.parse(research.caseEvidence)) !== inputHash(caseEvidence)) researchReuseStatus = 'STALE'
  const input = researchReuseStatus === 'REUSABLE' ? { ...research, case: currentCase, caseEvidence, factsConfirmed, legalQuestions: research.legalQuestions ?? [], ruleApplications: research.ruleApplications ?? [] }
    : { case: currentCase, caseEvidence, factsConfirmed, legalQuestions: [], ruleApplications: [],
      researchStatus: researchReuseStatus === 'STALE' ? 'INDETERMINATE' as const : undefined }
  const conditional = validatedConditionalResearch(input)
  if (conditional && conditional.acceptedCount < conditional.questionCount) input.researchStatus = 'INDETERMINATE'
  const assessment = assessCaseEvidence({ ...input, evidence: caseEvidence })
  return { input, assessment, researchReuseStatus }
}

export async function readReportVersions(folder: string): Promise<ReportSnapshot[]> {
  try { return indexSchema.parse(JSON.parse(await readFile(join(folder, 'reports', 'index.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

/** Caller holds the workspace mutation lock throughout snapshot, export and atomic index commit. */
export async function regenerateReport(folder: string, key: string, source: {
  research: Record<string, unknown> & { case: Case }; case: Case; evidence: unknown; factsConfirmed: boolean; researchRunId?: string
}, options: { pdfFontPath?: string } = {}): Promise<ReportSnapshot> {
  const frozen = structuredClone(source), now = new Date()
  const versions = await readReportVersions(folder), previous = versions.at(-1)
  const { input, assessment, researchReuseStatus } = currentReportInput(frozen.research, frozen.case, frozen.evidence, frozen.factsConfirmed, previous, frozen.researchRunId)
  const action = researchReuseStatus === 'REUSABLE' ? buildUserActionReport(input, now, '2.1') : undefined
  const conditional = validatedConditionalResearch(input)
  const continuationReport = buildCaseContinuationReport({ ...input, researchStatus: action
    ? conditional ? conditional.acceptedCount < conditional.questionCount ? 'INDETERMINATE' : 'COMPLETE'
      : action.continuation!.researchStatus === 'COMPLETE' ? 'COMPLETE' : 'INDETERMINATE' : input.researchStatus }, now)
  const policy = continuationReport.continuation
  const reportVersionId = `v${versions.length + 1}-${randomUUID()}`
  const answer = buildUserAnswerReport(input, policy, now, action)
  const complaintArtifacts = Object.fromEntries(['json', 'html', 'md', 'docx', 'pdf'].map(ext => [ext, `reports/${reportVersionId}/complaint.${ext}`]))
  const artifacts = Object.fromEntries(['json', 'html', 'md', 'docx', 'pdf'].map(ext => [ext, `reports/${reportVersionId}/report.${ext}`]))
  const internalArtifacts = Object.fromEntries(['json', 'html', 'md', 'docx', 'pdf'].map(ext => [ext, `reports/${reportVersionId}/internal.${ext}`]))
  const internal = researchReuseStatus === 'REUSABLE' ? buildInternalResearchReport(input, now)
    : { title: '内部研究报告', subtitle: '当前输入与研究复用边界', generatedAt: now.toISOString(), appendix: [], sections: [
      { title: '当前研究状态', blocks: [{ kind: 'paragraph' as const, text: researchReuseStatus === 'STALE'
        ? 'STALE：案件事实、材料或研究图已变化。旧研究不作为当前适用分析；请查看历史版本或重新研究。' : 'NOT_AVAILABLE：尚无可复用研究。' }] },
      { title: '当前事实', blocks: frozen.case.facts.concat(frozen.case.disputedFacts).map(f => ({ kind: 'paragraph' as const, text: `${f.id} · ${f.certainty} · ${f.content}` })) },
    ] }
  const evidence = caseEvidenceInputSchema.parse(frozen.evidence)
  const materials = evidence.items.map(e => {
    const recheck = e.file?.confirmationStatus === 'CONFIRMED'
      && evidence.links.some(l => l.evidenceId === e.id && l.status === 'SUGGESTED')
    return { id: e.id, title: e.title, stage: evidenceStage(e)
      + (recheck ? '；当前事实关联已撤销 / 需重新核对' : ''), hash: inputHash(e), linkHash: inputHash(evidence.links.filter(l => l.evidenceId === e.id)) }
  })
  const gaps = policy.gaps.map(g => ({ id: g.id, title: g.title, disposition: g.disposition,
    origin: g.title.startsWith('用于核对并支持') ? 'RESEARCH' as const : 'CURRENT' as const, factIds: g.factIds }))
  const changes: string[] = []
  if (!previous) changes.push('首次生成当前案件报告。')
  else {
    for (const item of materials) {
      const old = previous.materials.find(e => e.id === item.id)
      if (!old) changes.push(`新增材料：${item.title}。`)
      else if (old.stage !== item.stage) changes.push(`${item.title}：${old.stage} → ${item.stage}。`)
      else if (old.hash !== item.hash || old.linkHash !== undefined && old.linkHash !== item.linkHash) changes.push(`${item.title}：原文、登记信息或关联已更新。`)
    }
    for (const old of previous.materials) if (!materials.some(e => e.id === old.id)) changes.push(`移除材料：${old.title}。`)
    const removed = previous.gaps.filter(old => !gaps.some(g => g.id === old.id))
    const deferred = removed.filter(old => researchReuseStatus === 'STALE' && (old.origin === 'RESEARCH' || old.origin === undefined && old.title.startsWith('用于核对并支持')))
    const changedScope = removed.filter(old => !deferred.includes(old) && previous.caseInputHash !== inputHash(frozen.case))
    const closed = removed.filter(old => !deferred.includes(old) && !changedScope.includes(old))
    changes.push(closed.length ? `本次真正关闭的缺口（${closed.length}项）：${closed.map(g => g.title).join('；')}（按当前材料及信息核对结果；不代表真实性鉴定）。`
      : '本次无真正关闭的缺口。')
    // Legacy snapshots use the existing explicit research-gap title; a missing gap is not proof of satisfaction.
    changes.push(deferred.length ? `因研究已过期暂不沿用的缺口（${deferred.length}项）：${deferred.map(g => g.title).join('；')}。由于案件事实变化，上一版研究相关的部分缺口已不再沿用；需重新研究后重新评估，不表示材料已补齐。`
      : '本次无因研究已过期暂不沿用的缺口。')
    if (changedScope.length) changes.push(`因当前事实范围变化需重新核对的事项：${changedScope.map(g => g.title).join('；')}。不表示该事项已解决或材料已补齐。`)
    const added = gaps.filter(g => !previous.gaps.some(old => old.id === g.id))
    changes.push(added.length ? `新增的补充事项（${added.length}项）：${added.map(g => g.title).join('；')}。` : '本次无新增的补充事项。')
    if (previous.caseInputHash !== inputHash(frozen.case)) changes.push('案件事实或待澄清事项已更新；请核对本版事实记录。')
    const labels = { researchStatus: '法律研究状态', workflowStatus: '案件工作状态', filingReadiness: '草稿准备状态', evidenceReadiness: '材料准备状态' }
    for (const field of Object.keys(labels) as Array<keyof typeof labels>) {
      if (previous[field] !== policy[field]) changes.push(`${labels[field]}：${stateLabels[previous[field]]} → ${stateLabels[policy[field]]}。`)
    }
    const remaining = gaps.filter(g => previous.gaps.some(old => old.id === g.id))
    if (remaining.length) changes.push(`仍有${remaining.length}项补充事项未解决，包括：${remaining.slice(0, 3).map(g => g.title).join('；')}。详见本版补充清单。`)
    if (!changes.length) changes.push('当前检查未发现与上一版相比的输入或状态变化。')
  }
  const snapshot = reportSnapshotSchema.parse({ reportVersionId, version: versions.length + 1,
    caseId: frozen.case.id, caseKey: key, generatedAt: now.toISOString(), caseInputHash: inputHash(frozen.case), evidenceInputHash: inputHash(evidence),
    researchGraphHash: researchReuseStatus === 'NOT_AVAILABLE' ? undefined : researchGraphHash(frozen.research),
    researchReuseStatus, researchNeedsRefresh: researchReuseStatus === 'STALE', researchStatus: policy.researchStatus,
    workflowStatus: policy.workflowStatus, filingReadiness: policy.filingReadiness, evidenceReadiness: policy.evidenceReadiness,
    artifacts, internalArtifacts, complaintArtifacts, complaintStatus: answer.complaintDraft.status, researchRunId: frozen.researchRunId, previousVersionId: previous?.reportVersionId, materials, gaps, changes,
    sourceReferences: ['state.json', 'research.json', ...evidence.items.flatMap(e => e.sourceReference ? [e.sourceReference] : [])] })
  const p = (text: string) => ({ kind: 'paragraph' as const, text })
  const warning = researchReuseStatus === 'STALE'
    ? '你修改了重要案件事实或材料，之前的法律分析可能不再适用，建议重新分析。旧研究结论未作为本版确定结论展示。由于研究输入变化，上一版研究相关的部分缺口已不再沿用；需重新研究后重新评估，不表示材料已补齐。'
    : researchReuseStatus === 'NOT_AVAILABLE' ? '尚未完成法律研究；本版先整理当前信息与行动。' : ''
  const report = { ...answer, snapshot, continuation: policy, assessment, sections: [
    { ...answer.sections[0], blocks: [...answer.sections[0].blocks, ...(warning ? [p(warning)] : [])] },
    ...answer.sections.slice(1),
    { title: `当前报告：v${snapshot.version} · 版本与本次变化`, blocks: [
      p(`生成时间：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`), ...changes.map(p)] },
  ] }
  return commitReportVersion(folder, versions, snapshot, [
    { name: 'report', report }, { name: 'internal', report: { ...internal, snapshot } },
    { name: 'complaint', report: answer.complaintDraft },
  ], options)
}

/** Shared atomic export: keep the previous version until every selected format succeeds. */
export async function commitReportVersion(folder: string, versions: ReportSnapshot[], snapshot: ReportSnapshot,
  reports: Array<{ name: 'report' | 'internal' | 'complaint'; report: PrintableReport & { appendix: PrintableReport['sections']; snapshot?: ReportSnapshot; preliminary?: unknown } }>, options: { pdfFontPath?: string; signal?: AbortSignal; compact?: boolean } = {}) {
  options.signal?.throwIfAborted()
  const root = join(folder, 'reports'), staging = join(root, `.tmp-${randomUUID()}`), final = join(root, snapshot.reportVersionId)
  const indexTemporary = join(root, `.index-${randomUUID()}.tmp`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(staging, { mode: 0o700 })
  let promoted = false
  try {
    // No partially successful formats: every export must finish before the committed index changes.
    for (const { name, report } of reports) {
      for (const [ext, bytes] of [['json', JSON.stringify(report, null, 2)], ['html', renderUserHtml(report, options.compact)],
        ['md', renderUserMarkdown(report, options.compact)], ['docx', await renderDocx(report)], ['pdf', await renderPdf(report, options.pdfFontPath)]] as const) {
        await writeFile(join(staging, `${name}.${ext}`), bytes, { flag: 'wx', mode: 0o600 })
        options.signal?.throwIfAborted()
      }
    }
    await rename(staging, final); promoted = true
    options.signal?.throwIfAborted()
    await writeFile(indexTemporary, JSON.stringify([...versions, snapshot], null, 2), { flag: 'wx', mode: 0o600 })
    await rename(indexTemporary, join(root, 'index.json'))
    return snapshot
  } catch (error) {
    await rm(promoted ? final : staging, { recursive: true, force: true })
    throw error
  } finally { await rm(indexTemporary, { force: true }) }
}
