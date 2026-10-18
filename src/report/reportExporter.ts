import { open, mkdir } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { buildReport } from './reportBuilder.js'
import { ReportError } from './reportError.js'
import { buildUserCaseReport, renderUserHtml, renderUserMarkdown } from './userCaseReport.js'
import { buildUserActionReport } from './userActionReport.js'
import { printableUserActionReport, renderActionHtml, renderActionMarkdown, renderActionPdf } from './userActionRenderer.js'

export function sanitizeReportFilename(title: string): string {
  const name = Array.from(title.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')).slice(0, 60).join('').replace(/[. ]+$/g, '').trim()
  return !name ? '法律研究报告' : /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name) ? `_${name}` : name
}

export interface ReportExportResult {
  docxPath?: string
  pdfPath?: string
  userJsonPath?: string
  markdownPath?: string
  htmlPath?: string
  errors: ReportError[]
}

/** The caller must persist JSON first. Format failures are isolated and never delete JSON. */
export async function exportReports(input: unknown, jsonPath: string, options: { pdfFontPath?: string; now?: Date; signal?: AbortSignal; check?: () => void; audience?: 'internal' | 'user'; userReportVersion?: 'v1' | 'v2' | 'v2.1' } = {}): Promise<ReportExportResult> {
  const check = () => { options.check?.(); options.signal?.throwIfAborted() }
  check()
  const result: ReportExportResult = { errors: [] }
  let report, action
  try {
    action = options.audience === 'user' && options.userReportVersion !== 'v1' ? buildUserActionReport(input, options.now, options.userReportVersion === 'v2' ? '2' : '2.1') : undefined
    report = action ? printableUserActionReport(action) : options.audience === 'user' ? buildUserCaseReport(input, options.now) : buildReport(input, options.now)
  } catch (cause) {
    result.errors.push(cause instanceof ReportError ? cause : new ReportError('MODEL', '报告模型构建失败', { cause }))
    return result
  }
  const prefix = join(dirname(jsonPath), `${sanitizeReportFilename(report.subtitle)}-${basename(jsonPath, '.json')}`)
  for (const format of ['docx', 'pdf'] as const) {
    check()
    try {
      // Imports also stay inside the failure boundary: a missing exporter dependency cannot prevent JSON persistence.
      const render = format === 'docx'
        ? (await import('./docxExporter.js')).renderDocx
        : (await import('./pdfExporter.js')).renderPdf
      check()
      const bytes = format === 'pdf' && action ? await renderActionPdf(action, options.pdfFontPath) : await render(report, options.pdfFontPath)
      check()
      const path = `${prefix}.${format}`
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      check()
      // Exclusive creation prevents overwriting a report edited by its recipient.
      const handle = await open(path, 'wx', 0o600)
      try { check(); await handle.writeFile(bytes, { signal: options.signal }) } finally { await handle.close() }
      check()
      result[`${format}Path`] = path
    } catch (cause) {
      check()
      result.errors.push(new ReportError(format === 'docx' ? 'DOCX' : 'PDF', `${format.toUpperCase()} 报告导出失败；原始 JSON 保留`, { cause }))
    }
  }
  return result
}

/** Separate user artifacts leave legacy internal exports and the source Research JSON intact. */
export async function exportUserReports(input: unknown, jsonPath: string, options: {
  pdfFontPath?: string; now?: Date; signal?: AbortSignal; check?: () => void;
  userReportVersion?: 'v1' | 'v2' | 'v2.1';
  researchArtifact?: { path: string; sha256: string }
} = {}): Promise<ReportExportResult> {
  const result: ReportExportResult = { errors: [] }
  const check = () => { options.check?.(); options.signal?.throwIfAborted() }
  check()
  let report
  try { report = options.userReportVersion === 'v1' ? buildUserCaseReport(input, options.now) : buildUserActionReport(input, options.now, options.userReportVersion === 'v2' ? '2' : '2.1') } catch (cause) {
    result.errors.push(cause instanceof ReportError ? cause : new ReportError('MODEL', '用户报告构建失败', { cause }))
    return result
  }
  const prefix = join(dirname(jsonPath), basename(jsonPath, '.json'))
  const formats = [
    { key: 'userJsonPath', stage: 'USER_JSON', ext: '.user.json', content: () => JSON.stringify({ ...report, researchArtifact: options.researchArtifact }, null, 2) },
    { key: 'markdownPath', stage: 'MARKDOWN', ext: '.md', content: () => 'version' in report ? renderActionMarkdown(report) : renderUserMarkdown(report) },
    { key: 'htmlPath', stage: 'HTML', ext: '.html', content: () => 'version' in report ? renderActionHtml(report) : renderUserHtml(report) },
  ] as const
  for (const format of formats) {
    check()
    try {
      const content = format.content()
      const path = `${prefix}${format.ext}`
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      check()
      const handle = await open(path, 'wx', 0o600)
      try { check(); await handle.writeFile(content, { encoding: 'utf8', signal: options.signal }) } finally { await handle.close() }
      result[format.key] = path
    } catch (cause) {
      check()
      result.errors.push(new ReportError(format.stage, '用户报告格式导出失败；原始研究文件保留', { cause }))
    }
  }
  // Native exports carry a notice about the companion appendix. Do not create orphan print reports.
  if (!result.markdownPath && !result.htmlPath) return result
  const native = await exportReports(input, jsonPath, { ...options, now: new Date(report.generatedAt), audience: 'user' })
  return { ...result, docxPath: native.docxPath, pdfPath: native.pdfPath, errors: [...result.errors, ...native.errors] }
}
