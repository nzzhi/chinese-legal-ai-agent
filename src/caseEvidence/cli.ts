import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { caseSchema } from '../case/caseSchema.js'
import { legalQuestionSchema } from '../legalQuestion/legalQuestionSchema.js'
import { legalRuleApplicationSchema } from '../legalRule/legalRuleSchema.js'
import { assessCaseEvidence, caseEvidenceInputSchema } from './caseEvidence.js'
import { buildReport } from '../report/reportBuilder.js'
import { exportUserReports } from '../report/reportExporter.js'

async function readJson(path: string, limit: number): Promise<unknown> {
  const file = await stat(path)
  if (!file.isFile() || file.size > limit) throw new Error('Input must be a bounded regular JSON file')
  const bytes = await readFile(path)
  if (bytes.length > limit) throw new Error('Input JSON exceeds size limit')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

try {
  const [researchPath, evidencePath, directory = 'output', ...extra] = process.argv.slice(2)
  if (!researchPath || !evidencePath || extra.length) throw new Error('Usage: npm run case:evidence -- <research.json> <case-evidence.json> [output-directory]')
  const result = z.object({ case: caseSchema, legalQuestions: z.array(legalQuestionSchema),
    ruleApplications: z.array(legalRuleApplicationSchema) }).passthrough().parse(await readJson(researchPath, 50 * 1024 * 1024))
  const caseEvidence = caseEvidenceInputSchema.parse(await readJson(evidencePath, 2 * 1024 * 1024))
  const enriched = { ...result, caseEvidence,
    caseEvidenceAssessment: assessCaseEvidence({ ...result, evidence: caseEvidence }) }
  buildReport(enriched) // Validate existing research provenance before writing; never re-run retrieval.
  await mkdir(resolve(directory), { recursive: true, mode: 0o700 })
  const jsonPath = resolve(directory, `case-evidence-${randomUUID()}.json`)
  await writeFile(jsonPath, JSON.stringify(enriched, null, 2), { flag: 'wx', mode: 0o600 })
  const exports = await exportUserReports(enriched, jsonPath)
  console.log(JSON.stringify({ jsonPath, userJsonPath: exports.userJsonPath, htmlPath: exports.htmlPath, markdownPath: exports.markdownPath, docxPath: exports.docxPath, pdfPath: exports.pdfPath,
    errors: exports.errors.map(e => e.message) }))
  if (exports.errors.length) process.exitCode = 1
} catch (error) {
  console.error('案件材料导入失败：请检查 JSON schema、fact 关联、材料原文、审查记录及既有研究 provenance；未运行联网研究。')
  console.error(error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path, code: issue.code }))
    : error instanceof Error ? error.name : 'UnknownError')
  process.exitCode = 1
}
