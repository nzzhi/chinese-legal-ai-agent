import PDFDocument from 'pdfkit'
import { defaultPdfFont } from './pdfExporter.js'
import { disclaimer, type ReportBlock } from './reportModel.js'
import type { PrintableReport } from './userCaseReport.js'
import type { ActionLegalBasis, ActionQuestion, LegalBasisItem, UserActionReportModel } from './userActionReportModel.js'
import { ReportError } from './reportError.js'
import { continuationSummary } from './caseContinuationReport.js'
import { escapeHtml as escape, markdownText as markdown, safeSourceLink as safeLink } from './reportMarkup.js'

const p = (text: string): ReportBlock => ({ kind: 'paragraph', text })
const h = (text: string): ReportBlock => ({ kind: 'heading', text })
const gapLabel = (status: 'MISSING' | 'PARTIAL' | 'SATISFIED') => ({ MISSING: '未补充', PARTIAL: '部分补充', SATISFIED: '已有材料支持（完整性由用户确认）' })[status]
const basisBlocks = (basis: ActionLegalBasis[]): ReportBlock[] => basis.flatMap(b => [
  h(b.name), p(b.simpleExplanation), p(`与你的关系：${b.caseRelevance}`),
  ...(b.caveat ? [p(b.caveat)] : []), { ...p('官方来源'), href: safeLink(b.officialSource) },
])
const readableBasisBlocks = (items: LegalBasisItem[], full = false): ReportBlock[] => items.flatMap(b => [
  h(`《${b.lawName}》${b.articleNumber}`),
  ...(b.verificationStatus === 'VERIFIED' ? [p('条文原文：'), { kind: 'quote' as const, text: b.articleText }]
    : [p('该问题的法律依据尚未完整核验。')]),
  p(`与你的关系：${b.relevanceExplanation}`),
  ...(full ? [p(`对应案件事实：${b.relatedFacts.join('；') || '尚无直接关联事实，需要逐项核对。'}`)] : []),
  p(`相关材料：${b.relatedEvidence.join('；') || '尚未登记直接对应的用户材料，请先整理原始记录。'}`),
  ...(full ? [p(b.evidenceExplanation)] : []),
  p(`核验状态：${full || b.verificationStatus !== 'VERIFIED' ? b.verificationExplanation : '完整原文已按原研究记录核验；本案适用性仍需结合事实和材料审查。'}`),
  ...(full ? [p(`官方来源：${b.sourceName}`), p(`官方 URL：${safeLink(b.sourceUrl)}`),
    { ...p('查看官方原文 / 核验来源'), href: safeLink(b.sourceUrl) }] : []),
])
const questionBasisBlocks = (report: UserActionReportModel, q: ActionQuestion): ReportBlock[] => {
  if (report.version === '2') return basisBlocks(q.legalBasis)
  const items = (report.legalBasisItems ?? []).filter(b => b.relatedQuestionIds.some(id => q.trace.questionIds.includes(id)))
  return items.length ? [h('法律依据'), ...readableBasisBlocks(items)] : []
}
const questionEvidence = (report: UserActionReportModel, q: ActionQuestion) => q.relatedEvidence.length
  && !(report.version === '2.1' && q.legalBasisIds?.length) ? [p(`相关材料：${q.relatedEvidence.join('；')}`)] : []
const completeBasisSection = (report: UserActionReportModel) => ({ title: '本报告引用的法律依据',
  blocks: report.legalBasisItems?.length ? readableBasisBlocks(report.legalBasisItems, true) : [p('该问题的法律依据尚未完整核验。当前研究没有可展示的完整已核验条文原文。')] })

const loanCoreBlocks = (report: UserActionReportModel): ReportBlock[] => report.loanCoreAnalysis?.topics.flatMap(t => [
  h(t.question), p(t.coverage === 'RULE_AVAILABLE' ? '对应条文已核验，案件条件仍须核实。' : '当前对应法律依据不足。'),
  ...t.conditions.flatMap(c => [p(`规则要求：${c.requirement}`),
    ...c.facts.map(f => p(`${({ USER_STATED: '用户陈述', CONFIRMED_STATE: '系统已有确认标记（非独立核验）', GAP: '尚待确认', CONFLICT: '存在争议' })[f.stance]}：${f.content}`)),
    ...c.support.map(s => p(`材料“${report.caseMaterials?.find(e => e.evidenceId === s.evidenceId)?.title ?? '已登记材料'}”内容${s.degree === 'PARTIAL' ? '部分' : ''}支持“${c.facts.find(f => f.factId === s.factId)!.content}”（用户已确认关联${s.simulated ? '；SIMULATED / DEMO ONLY 模拟材料' : ''}）：${s.quote}`)),
    ...c.uncertainty.map(u => p(`仍需核对：${u}`)),
  ]), p(`条件性判断：${t.conclusion}`),
  ...readableBasisBlocks((report.legalBasisItems ?? []).filter(b => b.relatedRuleIds.some(id => t.ruleIds.includes(id)))),
]) ?? []

/** Disposable print projection AFTER the independent decision model has been built. */
export function printableUserActionReport(report: UserActionReportModel): PrintableReport {
  return { title: '你的案件行动报告', subtitle: report.caseTitle, generatedAt: report.generatedAt,
    sections: [
      { title: '这件事目前怎么看', blocks: [p(report.currentAssessment.text), p(report.currentAssessment.premise),
        h('对你有利的地方'), ...report.favorablePoints.flatMap(f => [h(f.title), p(f.explanation)]),
        ...(report.attentionPoints.length ? [h('需要重点核对'), ...report.attentionPoints.map(a => p(a.explanation))] : []),
        h('重点补强'), p(report.evidencePriorities.filter(e => e.family !== 'other' && e.status !== 'SATISFIED').map(e => e.title).join('；') || '先写清案件经过和你希望解决的事情。'),
        p(`现在先做：${report.nextActions[0]?.instruction ?? '保存现有原始记录。'}`)] },
      { title: '现在最重要的是补什么', blocks: report.evidencePriorities.flatMap(e => [h(e.title),
        ...(e.status ? [p(`材料状态：${gapLabel(e.status)}`)] : []),
        p(`要证明什么：${e.proofGoal}`), p(`你现在已有：${e.alreadyHave.join('；')}`),
        p(`建议补充：${e.recommendedEvidence.join('；')}`), p(`为什么重要：${e.importance}`)]) },
      ...(report.caseMaterials ? [{ title: '案件材料状态', blocks: report.caseMaterials.flatMap(e => [h(e.title), p(e.stage),
        p(`可能对应的事实：${e.relatedFacts.join('；') || '尚未建立事实关联'}`)]).concat(p('用户确认是内容登记，不代表真实性鉴定或法院采信。')) }] : []),
      ...(report.loanCoreAnalysis ? [{ title: '为什么：六个核心问题的条件分析', blocks: loanCoreBlocks(report) }] : []),
      { title: report.loanCoreAnalysis ? '补充问题' : '你关心的问题', blocks: report.userQuestions.flatMap(q => [h(q.userFacingQuestion), p(q.shortAnswer),
        p(q.explanation), ...questionBasisBlocks(report, q), ...questionEvidence(report, q)]) },
      { title: '下一步怎么做', blocks: [...report.nextActions.flatMap((a, i) => [h(`${i + 1}. ${a.title}`), p(a.instruction)]),
        ...(report.continuation ? continuationSummary(report.continuation) : []),
        h('本次报告的边界'), ...report.researchLimitations.map(p),
        p(report.version === '2.1' ? '本报告引用的完整已核验法律原文见下一节；全部问题与补充事项可查看配套 HTML / Markdown 附录或详细法律分析。'
          : '完整问题、补充事项和法律原文见配套 HTML / Markdown 附录；也可另行查看详细法律分析。'), p(disclaimer)] },
      ...(report.version === '2.1' ? [completeBasisSection(report)] : []),
    ] }
}

export function renderActionHtml(report: UserActionReportModel): string {
  const paragraph = (text: string) => `<p>${escape(text)}</p>`
  const card = (title: string, body: string, extra = '') => `<article class="card ${extra}"><h3>${escape(title)}</h3>${body}</article>`
  const basis = (b: ActionLegalBasis) => `<div class="basis"><h4>${escape(b.name)}</h4>${paragraph(b.simpleExplanation)}${paragraph(`与你的关系：${b.caseRelevance}`)}${b.caveat ? paragraph(b.caveat) : ''}<a href="${escape(safeLink(b.officialSource))}" rel="noreferrer">官方来源</a><details><summary>展开法律原文</summary>${paragraph(b.originalText)}</details></div>`
  const readableBlocks = (blocks: ReportBlock[]) => blocks.map(b => b.kind === 'heading' ? `<h4>${escape(b.text)}</h4>`
    : b.kind === 'quote' ? `<blockquote>${escape(b.text)}</blockquote>`
    : b.href ? `<p><a href="${escape(safeLink(b.href))}" rel="noreferrer">${escape(b.text)}</a></p>` : paragraph(b.text)).join('')
  const question = (q: UserActionReportModel['userQuestions'][number]) => card(q.userFacingQuestion,
    `<p class="answer">${escape(q.shortAnswer)}</p>${paragraph(q.explanation)}${report.version === '2.1' ? `<div class="basis">${readableBlocks(questionBasisBlocks(report, q))}</div>` : q.legalBasis.map(basis).join('')}${readableBlocks(questionEvidence(report, q))}`)
  const section = (title: string, body: string) => `<section class="page"><h2>${escape(title)}</h2>${body}</section>`
  const first = section('这件事目前怎么看', `<p class="assessment">${escape(report.currentAssessment.text)}</p><p class="muted">${escape(report.currentAssessment.premise)}</p><h2>对你有利的地方</h2><div class="grid">${report.favorablePoints.map(f => card(f.title, `${paragraph(f.explanation)}<details><summary>怎样把这一点证明完整</summary>${f.relatedFacts.map(paragraph).join('')}${f.relatedEvidence.map(paragraph).join('')}${paragraph(f.verificationCaveat)}</details>`)).join('')}</div>${report.attentionPoints.map(a => card(a.title, paragraph(a.explanation), 'attention')).join('')}<aside><strong>重点补强</strong>${paragraph(report.evidencePriorities.filter(e => e.family !== 'other' && e.status !== 'SATISFIED').map(e => e.title).join('；') || '案件经过与具体请求')}<strong>现在先做</strong>${paragraph(report.nextActions[0]?.instruction ?? '保存现有原始记录。')}</aside>`)
  const priorities = section('现在最重要的是补什么', `<div class="grid">${report.evidencePriorities.map(e => card(e.title,
    (e.status ? paragraph(`材料状态：${gapLabel(e.status)}`) : '') + paragraph(`要证明什么：${e.proofGoal}`) + paragraph(`你现在已有：${e.alreadyHave.join('；')}`)
    + paragraph(`建议补充：${e.recommendedEvidence.join('；')}`) + paragraph(`为什么重要：${e.importance}`))).join('')}</div>`)
  const continuation = report.continuation ? section('继续处理与待补事项', readableBlocks(continuationSummary(report.continuation))) : ''
  const core = report.loanCoreAnalysis ? section('为什么：六个核心问题的条件分析', readableBlocks(loanCoreBlocks(report))) : ''
  const questions = section(report.loanCoreAnalysis ? '补充问题' : '你关心的问题', report.userQuestions.map(question).join(''))
  const materials = report.caseMaterials ? section('案件材料状态', report.caseMaterials.map(e => card(e.title,
    paragraph(e.stage) + paragraph(`可能对应的事实：${e.relatedFacts.join('；') || '尚未建立事实关联'}`))).join('')
    + paragraph('用户确认是内容登记，不代表真实性鉴定或法院采信。')) : ''
  const actions = section('下一步怎么做', `<ol>${report.nextActions.map(a => `<li><h3>${escape(a.title)}</h3>${paragraph(a.instruction)}</li>`).join('')}</ol><aside>${report.researchLimitations.map(paragraph).join('')}${paragraph(disclaimer)}</aside>`)
  const appendix = `<details class="appendix"><summary>${escape(report.appendixRef.label)}</summary><h2>全部用户问题</h2>${report.appendix.allQuestions.map(question).join('')}<h2>完整补充事项</h2>${report.appendix.evidenceGaps.map(g => card(g.description, paragraph(g.purpose) + g.suggestions.map(paragraph).join(''))).join('')}${report.version === '2' ? `<h2>完整法律依据</h2>${report.legalBasis.map(basis).join('')}` : ''}</details>`
  const completeBasis = report.version === '2.1' ? section('本报告引用的法律依据', readableBlocks(completeBasisSection(report).blocks)) : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(report.caseTitle)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#233341;font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:940px;margin:auto;padding:28px 22px}header{padding:12px 4px}h1{font-size:26px;margin:0 0 8px}h2{font-size:21px;margin:0 0 18px}h3{font-size:17px;margin:0 0 9px}h4{font-size:15px;margin:0 0 6px}p{margin:8px 0;overflow-wrap:anywhere}.page{background:white;border-radius:16px;padding:28px;margin:18px 0 28px}.assessment{font-size:18px;line-height:1.8}.muted{color:#5c6b77;font-size:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card{background:#f8fafb;border:1px solid #e0e7ec;border-radius:12px;padding:18px;margin:0 0 14px;break-inside:avoid}.grid .card{margin:0}aside{background:#edf5f6;border-left:4px solid #357778;padding:14px 18px;margin-top:20px;border-radius:4px}.attention{background:#fff6ed;border-color:#e7c7a6}.answer{font-weight:600}.basis{border-top:1px solid #dfe7eb;margin-top:16px;padding-top:14px;color:#455560;font-size:14px}a{color:#23676b;overflow-wrap:anywhere}details{margin-top:12px}summary{cursor:pointer;color:#3c626b}.appendix{background:#fff;padding:24px;border-radius:12px}ol{padding-left:24px}li{margin:16px 0}footer{font-size:12px;color:#6d7880;padding:12px}
  @media(max-width:640px){main{padding:12px}.page{padding:20px}.grid{grid-template-columns:1fr}h1{font-size:23px}}@media print{body{background:white}main{max-width:none;padding:0}.page{break-before:page;box-shadow:none;padding:0}header+.page{break-before:auto}.appendix,details{display:none}.grid{grid-template-columns:1fr 1fr}a{color:inherit}footer{display:none}}
  </style></head><body><main><header><h1>${escape(report.caseTitle)}</h1><p class="muted">围绕你的事情，先看现状，再准备下一步</p></header>${first}${continuation}${priorities}${materials}${core}${questions}${actions}${appendix}${completeBasis}<footer>生成时间：${escape(report.generatedAt)}</footer></main></body></html>`
}

export function renderActionMarkdown(report: UserActionReportModel): string {
  const printable = printableUserActionReport(report)
  const blocks = (values: ReportBlock[]) => values.map(b => b.href
    ? `[${markdown(b.text)}](<${safeLink(b.href).replace(/[<>]/g, c => encodeURIComponent(c))}>)`
    : `${b.kind === 'heading' ? '### ' : b.kind === 'quote' ? '> ' : ''}${markdown(b.text)}`).join('\n\n')
  return `# ${markdown(report.caseTitle)}\n\n${printable.sections.filter(s => s.title !== '本报告引用的法律依据').map(s => `## ${markdown(s.title)}\n\n${blocks(s.blocks)}`).join('\n\n')}\n\n# 附录\n\n`
    + report.appendix.allQuestions.map(q => blocks([h(q.userFacingQuestion), p(q.shortAnswer), p(q.explanation), ...questionBasisBlocks(report, q)])).join('\n\n')
    + '\n\n## 完整补充事项\n\n' + report.appendix.evidenceGaps.map(g => blocks([h(g.description), p(g.purpose), ...g.suggestions.map(p)])).join('\n\n')
    + (report.version === '2.1' ? '\n\n## 本报告引用的法律依据\n\n' + blocks(completeBasisSection(report).blocks)
      : '\n\n## 法律原文\n\n' + report.legalBasis.map(b => blocks([h(b.name), { kind: 'quote', text: b.originalText }, ...basisBlocks([b]).slice(1)])).join('\n\n')) + '\n'
}

/** Only v2 uses card pagination. Legacy Research/v1 exporters are unchanged. */
export async function renderActionPdf(report: UserActionReportModel, fontPath = defaultPdfFont()): Promise<Buffer> {
  if (!fontPath) throw new ReportError('PDF', '请设置 REPORT_PDF_FONT_PATH 为可嵌入的中文字体路径')
  const printable = printableUserActionReport(report)
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: report.caseTitle } })
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      doc.font(fontPath)
      let activeSize = 10.5, activeColor = '#263b49'
      const footer = () => {
        const y = doc.y
        doc.fontSize(8).fillColor('#687680').text(`生成时间：${report.generatedAt}`, 48, 804, { lineBreak: false })
        doc.x = 48; doc.y = y
        doc.fontSize(activeSize).fillColor(activeColor)
      }
      footer(); doc.on('pageAdded', footer)
      const write = (text: string, size = 10.5, color = '#263b49', href?: string) => {
        activeSize = size; activeColor = color
        doc.fontSize(size).fillColor(color)
        const height = doc.heightOfString(text, { width: 499, lineGap: 3 })
        if (doc.y + height > 775) { doc.addPage(); doc.fontSize(size).fillColor(color) }
        doc.text(text, 48, doc.y, { width: 499, lineGap: 3, link: href ?? null, underline: !!href }).moveDown(0.35)
      }
      write(report.caseTitle, 21)
      for (const [index, section] of printable.sections.entries()) {
        if (index) doc.addPage()
        write(section.title, 17, '#245d67')
        for (const [i, block] of section.blocks.entries()) {
          if (block.kind === 'heading') {
            const next = section.blocks[i + 1]
            doc.fontSize(10.5)
            const nextHeight = next ? Math.min(doc.heightOfString(next.text, { width: 475, lineGap: 3 }), 120) : 0
            doc.fontSize(11.5)
            const headingHeight = Math.max(24, doc.heightOfString(block.text, { width: 479, lineGap: 3 }) + 10)
            if (doc.y + headingHeight + 10 + nextHeight > 775) doc.addPage()
            const y = doc.y
            activeSize = 11.5; activeColor = '#245d67'
            doc.roundedRect(48, y, 499, headingHeight, 4).fill('#edf4f6')
            doc.fillColor('#245d67').fontSize(11.5).text(block.text, 58, y + 4, { width: 479 })
            doc.x = 48; doc.y = y + headingHeight + 5
          } else write(block.text, 10.5, '#263b49', block.href)
        }
      }
      doc.end()
    } catch (cause) { doc.destroy(); reject(new ReportError('PDF', '行动报告 PDF 生成失败', { cause })) }
  })
}
