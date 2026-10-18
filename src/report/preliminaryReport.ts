import { randomUUID } from 'node:crypto'
import { validatePreliminaryResult, preliminarySources } from '../assistant/preliminaryWorkflow.js'
import { evidenceStage } from '../caseEvidence/caseEvidence.js'
import { preliminaryCoverage } from '../assistant/preliminaryCoverage.js'
import type { PrintableReport } from './userCaseReport.js'
import { commitReportVersion, inputHash, readReportVersions, reportSnapshotSchema } from './reportRegeneration.js'
import { preliminaryCitationText, assessPreliminaryQuality, PreliminaryQualityError,
  isPreliminaryLegalResearchTask, preliminaryLegalResearchTopics, hasPreliminaryLegalAssertion } from '../assistant/preliminaryQuality.js'

const p = (text: string) => ({ kind: 'paragraph' as const, text })
const h = (text: string) => ({ kind: 'heading' as const, text })
const unique = (values: string[]) => [...new Map(values.map(value => [value.replace(/[\s，,；;。.!！?？]/gu, ''), value])).values()]

export function buildPreliminaryReport(input: unknown): PrintableReport & { appendix: PrintableReport['sections'] } {
  const r = validatePreliminaryResult(input), sources = preliminarySources(r)
  const quality = assessPreliminaryQuality(r, sources)
  const sourceById = new Map(sources.map(s => [s.providerSourceId, s]))
  const status = { INFERENCE: '初步判断', TO_VERIFY: '事实与证据条件' }
  const facts = r.case.facts.concat(r.case.disputedFacts)
  // Retrieval candidates stay in the audit; the user sees only articles actually cited in case findings.
  const citations = r.analysis.findings.flatMap(f => f.citations.map(c => ({ ...c, finding: f })))
  const citedIds = [...new Set(citations.map(c => c.sourceId))]
  const displayedContext = new Set<string>()
  const items = r.caseEvidence.items.filter(e => e.file?.confirmationStatus !== 'REJECTED'
    && (e.file || e.content || !r.caseEvidence.items.some(u => u.file && u.type === e.type && u.file.confirmationStatus !== 'REJECTED')))
  const names: Record<string, string> = { PAYMENT_RECORD: '转账记录', CHAT_RECORD: '聊天记录', CONTRACT: '合同或借条', IMAGE: '图片材料', OTHER: '补充材料' }
  const analyzedFacts = new Set(r.analysis.evidenceAnalysis.flatMap(a => a.factIds))
  const uncorroborated = facts.filter(f => !analyzedFacts.has(f.id))
  const missingSearches = preliminaryCoverage(r).filter(c => c.status === 'INSUFFICIENT')
  const unsupported = quality.issues.filter(i => i.code === 'UNSUPPORTED_TOPIC_CONCLUSION')
  const unsafeGlobal = unsupported.some(i => i.findingIndex === undefined)
  // Older model responses may mix legal research into user tasks. Preserve the raw analysis in the audit.
  const tasks = r.analysis.nextSteps.flatMap(text => text.split(/[。；;]/u).map(t => t.trim()).filter(Boolean))
  const safeTasks = tasks.filter(text => !isPreliminaryLegalResearchTask(text) && (!unsafeGlobal || !hasPreliminaryLegalAssertion(text)))
  const delegated = [...tasks, ...r.analysis.uncertainties].filter(isPreliminaryLegalResearchTask)
  const factQuestions = r.analysis.uncertainties.filter(text => !isPreliminaryLegalResearchTask(text))
  if (quality.issues.some(i => i.code === 'DOCUMENT_SCOPE_TO_VERIFY')) {
    const housing = r.documentContexts?.some(c => c.articles.some(a => /住房|土地/u.test(a.text)))
    const statedHousingScope = facts.some(f => /城镇国有土地|集体土地|保障性住房/u.test(f.content))
    if (housing && !statedHousingScope) factQuestions.push('请补充房屋所在地、用途及已有的权属或土地信息；不清楚土地性质时，提供现有合同或权属材料即可，由系统判断法规适用范围。')
  }
  if (quality.issues.some(i => i.code === 'TEMPORAL_APPLICATION_TO_VERIFY')) {
    factQuestions.push('请补充订约、付款、履行及争议行为发生的具体日期，或提供载有日期的合同、记录；由系统判断适用版本及过渡规则。')
  }
  if (!factQuestions.length && quality.issues.some(i => i.code === 'UNRESOLVED_PREMISE')) {
    factQuestions.push(...citations.flatMap(c => c.checks?.filter(a => a.assessment === 'UNRESOLVED'
      && !isPreliminaryLegalResearchTask(a.reason)).map(a => a.reason) ?? []))
  }
  const legalLimits = [...r.analysis.legalLimitations ?? []]
  // Aggregate by document, not by citation or internal check: one meaningful limitation per law.
  const issueGroups = new Map<string, typeof quality.issues>()
  for (const issue of quality.issues) {
    const source = issue.sourceId && sourceById.get(issue.sourceId)
    const key = source ? source.authority?.document.id ?? source.providerSourceId : 'analysis'
    issueGroups.set(key, [...issueGroups.get(key) ?? [], issue])
  }
  for (const issues of issueGroups.values()) {
    const source = issues[0].sourceId && sourceById.get(issues[0].sourceId)
    const label = source ? `《${source.title}》：` : ''
    const has = (...codes: string[]) => issues.some(i => codes.includes(i.code))
    const limits: string[] = []
    if (has('DOCUMENT_SCOPE_NOT_CHECKED') && !r.documentContexts?.some(c => c.documentId === (source && source.authority?.document.id))) {
      limits.push('系统尚未取得该法规的范围条款，不能据此确认其适用于本案')
    }
    if (has('DOCUMENT_SCOPE_TO_VERIFY')) limits.push('该依据仅适用于第二部分所列的对象和事项，相关结论以满足该范围为前提，不能直接扩展到其他法律关系')
    if (has('TEMPORAL_APPLICATION_TO_VERIFY')) limits.push(`所引版本${source && source.authority?.document.effectiveAt ? `自${source.authority.document.effectiveAt}施行` : '施行日期未确认'}；对施行前的订约或行为，不能仅凭该版本作出结论，缺少相关事实日期时暂不确认其时间适用`)
    if (has('UNASSESSED_BURDEN_REASONING')) limits.push('不同抗辩的证明责任不能作同等处理，不能据此认定举证责任转移或免除原告应负的证明责任；须以对方实际抗辩及证据为基础分别分析')
    else if (has('UNVERIFIED_ALTERNATIVE', 'INAPPLICABLE_PREMISE')) limits.push('所引条文不能单独支持报告中的所有并列情形，相同法律后果暂不作为确定结论')
    if (has('UNASSESSED_VARIATION_REASONING')) limits.push('系统尚未将期限变化判断与相应变更或展期规则充分对应，须分别审查适用时点、双方同意及变更内容；仅凭原期限返还义务，暂不能确认期限是否已经变更')
    if (has('UNSOURCED_FINDING', 'REFERENCE_ONLY')) limits.push('部分判断缺少已确认效力的规范依据，公开参考或事实陈述不能代替该依据')
    if (limits.length) legalLimits.push(label + limits.join('；') + '。')
  }
  if (delegated.length) legalLimits.push(`关于${unique(delegated.flatMap(preliminaryLegalResearchTopics)).join('、')}，本次尚未完成核验，相应结论不能视为确定；该工作由系统负责，不列为用户查法任务。`)
  legalLimits.push(...missingSearches.map(t => `关于“${t.query}”（${t.reason}），系统尚未取得充分对应的有效规范依据，其他争点的来源或公开参考不能替代，本报告不据此作肯定判断。`))
  return { title: r.analysis.title ?? '法律分析报告', subtitle: 'AI 法律助手 · 初步分析', generatedAt: r.generatedAt, appendix: [], sections: [
    { title: '一、案件结论', blocks: [
      ...(missingSearches.length ? [p(`本次尚未核实以下核心争点的充分法律依据：${missingSearches.map(t => t.query).join('；')}。相关法律结论暂不确认，以下仅在已取得依据及明确条件内作初步分析。`)] : []),
      p(unsafeGlobal ? '系统尚未核实支持相关法律判断的充分依据，暂不确认责任或请求是否成立。可以先整理已有陈述与材料；具体缺口见第四部分。' : r.analysis.summary),
      ...r.analysis.findings.flatMap((f, i) => unsupported.some(u => u.findingIndex === i)
        ? [h('暂不确认的法律判断'), p('本项尚缺能够对应该争点的有效规范，已保留系统补查缺口；暂不展示原草稿的肯定判断。')]
        : [h(`${status[f.status]}：${f.conclusion}`), p(f.reasoning)]),
    ] },
    { title: '二、主要法律依据', blocks: citedIds.length ? citedIds.flatMap(id => {
      const s = sourceById.get(id)!, related = citations.filter(c => c.sourceId === id)
      const document = s.authority?.document
      const firstDocument = document && !displayedContext.has(document.id)
      const context = firstDocument
        ? r.documentContexts?.find(c => c.documentId === document.id)?.articles.filter(a => !citedIds.includes(a.id)) ?? [] : []
      if (document) displayedContext.add(document.id)
      return [h(s.authority ? `《${s.title}》${s.authority.article.articleNumber}` : `公开参考：${s.title}`),
        ...[...new Set(related.map(c => preliminaryCitationText(s, c.quote)))].map(text => ({ kind: 'quote' as const, text })),
        p(`本案关联：${related.some(c => unsupported.some(u => r.analysis.findings[u.findingIndex ?? -1] === c.finding))
          ? '原文来源已核验，但尚不足以支持该项法律判断，暂不确认本案适用。'
          : [...new Set(related.map(c => c.relevance ?? c.finding.conclusion))].join('；')}`),
        ...context.flatMap(a => [h(`适用范围、例外或施行规定 · ${a.articleNumber}`), { kind: 'quote' as const, text: a.text }]),
        ...(firstDocument ? [p(`法源核验记录：官方原文与效力依据已核对（${document.validityEvidence?.checkedAt.slice(0, 10) ?? s.verifiedAt.slice(0, 10)}）；所引版本自${document.effectiveAt ?? '尚未确认的日期'}施行。此为法源记录，本案适用分析的限制见第四部分。`)] : []),
        ...(!s.authority ? [p('已核对网页原文；尚未确认现行效力，不能单独作为确定法律结论的依据。')] : []),
        { kind: 'paragraph' as const, text: `公开来源：${new URL(s.sourceUrl).hostname}`, href: s.sourceUrl },
      ]
    }) : [p(sources.length ? '本次尚未取得能直接对应本案结论的法条依据；下列建议以材料整理为主。' : '本地检索未取得可引用法条，暂不能给出有法条支撑的结论。')] },
    { title: '三、事实与证据对应', blocks: [
      ...(items.some(e => e.content) ? [p('以下是已读取的材料内容及其证明目的。内容识别与真实性证明不同；原始记录、双方身份和完整上下文仍是判断证据的关键。')] : [p('本次仅依据你的陈述，尚未读取证据材料；未上传不代表现实中不存在材料，也不代表诉讼中没有提交证据。')]),
      ...items.flatMap((e, i) => {
        const analyses = r.analysis.evidenceAnalysis.filter(a => a.evidenceId === e.id)
        return [h(`材料${i + 1}：${analyses[0]?.label ?? names[e.type] ?? '案件材料'}`),
          ...(e.file?.extractionMethod === 'LOCAL_OCR' && e.content ? [p('图片识别文字：请对照原图核对金额、日期及姓名。')] : []),
          ...analyses.flatMap(a => [ { kind: 'quote' as const, text: a.quote },
            ...(a.factIds.length ? [p(`对应陈述：${a.factIds.map(id => facts.find(f => f.id === id)!.content).join('；')}`)] : []),
            p(`证明目的：${a.meaning} 限制：${a.limitation}`),
          ]),
          ...(!analyses.length ? [p(!e.content ? e.file?.mimeType.startsWith('image/')
            ? '图片文字未能识别，本报告无法据此判断金额、身份或约定。请裁剪清晰区域重新上传，或登记关键原文。'
            : '尚未读取正文，无法判断证明内容；请提供可读原文。' : '文字已读取，本次尚未形成具体证明目的。')] : []),
        ]
      }),
      ...(items.some(e => e.content) && uncorroborated.length ? [p(`${r.factsConfirmed ? '你已核对、尚未与已读材料对应的陈述' : '尚未与已读材料对应的陈述'}：${unique(uncorroborated.map(f => f.content)).join('；')}`)] : []),
    ] },
    { title: '四、主要风险与分析限制', blocks: [
      ...unique((r.analysis.risks ?? []).filter(text => !unsafeGlobal || !hasPreliminaryLegalAssertion(text))).map(p),
      ...(legalLimits.length ? [h('法律分析的限制（由系统负责）'), ...unique(legalLimits).map(p)] : []),
    ] },
    { title: '五、建议行动与事实补充', blocks: [
      ...unique(safeTasks.length ? safeTasks : ['保存现有原始材料及完整沟通记录；相关请求和责任须待系统补足法律依据后再判断'])
        .map((text, i) => p(`${i + 1}. ${text}。`)),
      ...(factQuestions.length ? [h('请补充的案件事实与材料'), ...unique(factQuestions).map(p)] : []),
    ] },
  ] }
}

export async function exportPreliminaryReport(folder: string, key: string, input: unknown, runId: string,
  options: { pdfFontPath?: string; signal?: AbortSignal } = {}) {
  const result = validatePreliminaryResult(input), quality = assessPreliminaryQuality(result, preliminarySources(result))
  if (quality.status === 'BLOCKED') throw new PreliminaryQualityError(quality)
  const report = buildPreliminaryReport(result)
  const versions = await readReportVersions(folder), reportVersionId = `v${versions.length + 1}-${randomUUID()}`
  const artifacts = Object.fromEntries(['json', 'html', 'md', 'docx', 'pdf'].map(ext => [ext, `reports/${reportVersionId}/report.${ext}`]))
  const snapshot = reportSnapshotSchema.parse({ mode: 'PRELIMINARY', reportVersionId, version: versions.length + 1,
    caseId: result.case.id, caseKey: key, generatedAt: result.generatedAt, caseInputHash: inputHash(result.case),
    evidenceInputHash: inputHash(result.caseEvidence), researchGraphHash: inputHash(result), researchReuseStatus: 'REUSABLE',
    researchNeedsRefresh: false, researchStatus: 'PARTIAL', workflowStatus: 'PARTIAL', filingReadiness: 'NEEDS_INFORMATION',
    evidenceReadiness: result.caseEvidence.items.length ? 'PARTIAL' : 'MISSING', artifacts,
    previousVersionId: versions.at(-1)?.reportVersionId, researchRunId: runId,
    sourceReferences: [`preliminary/${runId}.json`, ...preliminarySources(result).map(s => s.sourceUrl)],
    materials: result.caseEvidence.items.map(e => ({ id: e.id, title: e.title ?? e.id, stage: evidenceStage(e), hash: inputHash(e) })),
    gaps: [...new Set([...result.analysis.uncertainties, ...quality.issues.map(i => i.message)])]
      .map((title, i) => ({ id: `preliminary-gap-${i + 1}`, title, disposition: '待核实' })),
    changes: ['生成初步法律分析；旧严格研究成果与历史报告保留。'],
  })
  // Technical provenance/metrics remain in preliminary/<runId>.json and reports/index.json, never user artifacts.
  return commitReportVersion(folder, versions, snapshot, [{ name: 'report', report }], { ...options, compact: true })
}
