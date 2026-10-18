import { Document, ExternalHyperlink, Footer, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import type { PrintableReport } from './userCaseReport.js'

export async function renderDocx(report: PrintableReport): Promise<Buffer> {
  const font = { ascii: 'SimHei', eastAsia: 'SimHei', hAnsi: 'SimHei', cs: 'SimHei' }
  const heading = (text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel]) =>
    new Paragraph({ text, heading: level, keepNext: true })
  return Packer.toBuffer(new Document({
    title: report.title, creator: 'Chinese Legal Research Agent',
    styles: {
      default: {
        document: { run: { font, size: 22, color: '222222' }, paragraph: { spacing: { after: 140, line: 330 } } },
        title: { run: { font, size: 40, bold: true, color: '000000' }, paragraph: { spacing: { after: 220 } } },
        heading1: { run: { font, size: 30, bold: true, color: '000000' }, paragraph: { spacing: { before: 280, after: 160 }, keepNext: true } },
        heading2: { run: { font, size: 24, bold: true, color: '000000' }, paragraph: { spacing: { before: 160, after: 100 }, keepNext: true } },
      },
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: `生成日期：${report.generatedAt}`, size: 16, color: '666666' })] })] }) },
      children: [
        heading(report.title, HeadingLevel.TITLE), new Paragraph(report.subtitle),
        ...report.sections.flatMap(section => [heading(section.title, HeadingLevel.HEADING_1), ...section.blocks.map(block =>
          block.kind === 'heading' ? heading(block.text, HeadingLevel.HEADING_2)
            : new Paragraph({ children: [block.href
              ? new ExternalHyperlink({ link: block.href, children: [new TextRun({ text: block.text, style: 'Hyperlink' })] })
              : new TextRun({ text: block.text })], widowControl: true,
              ...(block.kind === 'quote' ? { indent: { left: 280 }, shading: { fill: 'F3F4F5' } } : {}),
            })),
        ]),
      ],
    }],
  }))
}
