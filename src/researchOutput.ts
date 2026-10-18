import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResearchWorkflowResult } from './integration/researchWorkflow.js'
import { exportReports, exportUserReports } from './report/reportExporter.js'

export async function saveResearchResult(
  result: ResearchWorkflowResult,
  outputDirectory = fileURLToPath(new URL('../output/', import.meta.url)),
  options: { signal?: AbortSignal; check?: () => void } = {},
): Promise<string> {
  options.check?.()
  options.signal?.throwIfAborted()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = resolve(outputDirectory, `research-${timestamp}.json`)
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  options.check?.()
  // Only workflow output is saved; configuration and environment are not included.
  await writeFile(filePath, JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600, signal: options.signal })
  options.check?.()
  return filePath
}

export async function saveResearchArtifacts(
  result: ResearchWorkflowResult,
  outputDirectory?: string,
  options: { pdfFontPath?: string; signal?: AbortSignal; check?: () => void; audience?: 'internal' | 'user' } = {},
) {
  const jsonPath = await saveResearchResult(result, outputDirectory, options)
  return { jsonPath, ...await (options.audience === 'internal' ? exportReports : exportUserReports)(result, jsonPath, options) }
}
