import { readFile, stat, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { exportUserReports } from './reportExporter.js'

try {
  const args = process.argv.slice(2)
  const detailed = args.includes('--detailed')
  const v2 = args.includes('--v2')
  const [inputPath, directory = 'output', ...extra] = args.filter(a => a !== '--detailed' && a !== '--v2')
  if (!inputPath || extra.length || detailed && v2) throw new Error('Usage: npm run case:report -- <research.json> [output-directory] [--detailed | --v2]')
  const path = resolve(inputPath)
  const info = await stat(path)
  if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('Input must be a bounded regular JSON file')
  const bytes = await readFile(path)
  if (bytes.length > 50 * 1024 * 1024) throw new Error('Input JSON exceeds size limit')
  const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  const output = resolve(directory)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const exports = await exportUserReports(data, resolve(output, `user-case-${randomUUID()}.json`), {
    userReportVersion: detailed ? 'v1' : v2 ? 'v2' : 'v2.1',
    researchArtifact: { path, sha256: createHash('sha256').update(bytes).digest('hex') },
  })
  console.log(JSON.stringify({ ...exports, errors: exports.errors.map(e => ({ stage: e.stage, message: e.message })) }))
  if (exports.errors.length) process.exitCode = 1
} catch (error) {
  console.error('用户报告导出失败：请检查输入格式和既有研究关联；原始研究文件保留，未运行联网研究。')
  console.error(error instanceof Error ? error.name : 'UnknownError')
  process.exitCode = 1
}
