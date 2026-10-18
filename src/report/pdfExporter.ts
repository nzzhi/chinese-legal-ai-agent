import PDFDocument from 'pdfkit'
import { fileURLToPath } from 'node:url'
import type { PrintableReport } from './userCaseReport.js'
import { ReportError } from './reportError.js'

export function defaultPdfFont(): string | undefined {
  return process.env.REPORT_PDF_FONT_PATH || fileURLToPath(new URL('../../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url))
}

export async function renderPdf(report: PrintableReport, fontPath = defaultPdfFont()): Promise<Buffer> {
  if (!fontPath) throw new ReportError('PDF', '请设置 REPORT_PDF_FONT_PATH 为可嵌入的中文 TTF/OTF 字体路径')
  const doc = new PDFDocument({ size: 'A4', margin: 57, info: { Title: report.title, Author: 'Chinese Legal Research Agent' } })
  const chunks: Buffer[] = []
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      doc.font(fontPath)
      let activeSize = 11
      let activeColor = '#222222'
      const footer = () => {
        const y = doc.y
        doc.fontSize(8).fillColor('#666666').text(`生成日期：${report.generatedAt}`, 57, 810, { lineBreak: false })
        doc.y = y
        doc.x = 57
        doc.fontSize(activeSize).fillColor(activeColor)
      }
      footer()
      doc.on('pageAdded', footer)
      const write = (text: string, size: number, heading = false, quote = false, href?: string) => {
        activeSize = size
        activeColor = quote ? '#555555' : '#222222'
        doc.fontSize(size)
        const height = doc.heightOfString(text, { width: quote ? 469 : 481, lineGap: 5, paragraphGap: 8 })
        // Keep headings with at least two lines of following body text.
        if (doc.y + height + (heading ? 65 : 0) > 780 && (heading || height <= 180)) doc.addPage()
        doc.fontSize(size).fillColor(activeColor)
          .text(text, quote ? 69 : 57, doc.y, { width: quote ? 469 : 481, lineGap: 5, paragraphGap: 8,
            link: href ?? null, underline: !!href })
      }
      write(report.title, 20, true)
      write(report.subtitle, 11)
      for (const section of report.sections) {
        doc.moveDown(0.4)
        write(section.title, 15, true)
        for (const block of section.blocks) write(block.text, block.kind === 'heading' ? 12 : 11, block.kind === 'heading', block.kind === 'quote', block.href)
      }
      doc.end()
    } catch (cause) {
      doc.destroy()
      reject(new ReportError('PDF', 'PDF 生成失败，请检查中文字体路径和报告内容', { cause }))
    }
  })
}
