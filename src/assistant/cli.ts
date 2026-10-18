import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { AcceptanceBudget } from '../integration/acceptanceBudget.js'
import { EvidenceWorkspace } from '../caseEvidence/workspace.js'
import { createWorkbenchRuntime } from '../workbench/researchRuntime.js'

/** Default CLI uses the same short path, storage and exporters as the Workbench. */
export async function runPreliminaryCli(rawCase: string) {
  const root = resolve('output', `assistant-${randomUUID()}`), started = performance.now()
  const budget = new AcceptanceBudget({ queries: 6, verifications: 18, httpRequests: 2, durationMs: 300_000 })
  const workspace = new EvidenceWorkspace(root)
  let key: string | undefined, id: string | undefined
  let runtime: ReturnType<typeof createWorkbenchRuntime> | undefined
  try {
    runtime = createWorkbenchRuntime(budget, { mode: 'PRELIMINARY' })
    const workflow = runtime.preliminary!
    const intake = await budget.run(() => workflow.intake(rawCase))
    key = (await workspace.importInitialCase(rawCase, intake.case, intake)).key
    id = randomUUID()
    const snapshot = await workspace.beginResearch(key, id, 'PRELIMINARY')
    const result = await budget.run(() => workflow.run({ ...snapshot, factsConfirmed: snapshot.factsConfirmed ?? false }, stage => console.log(stage)))
    await workspace.savePreliminary(key, id, result)
    const report = await budget.run(() => workspace.regenerateReport(key!, { signal: budget.signal, runId: id }))
    budget.check()
    await workspace.finishPreliminary(key, id)
    console.log(`初步分析已导出：${resolve(root, key, report.artifacts.html)}`)
    console.log(`总耗时 ${(performance.now() - started).toFixed(1)}ms；逻辑模型调用 ${result.metrics.totalModelCallCount} 次；法律网站 HTTP 0。`)
  } catch (error) {
    budget.cancel()
    if (key && id) await workspace.updateResearch(key, id, '初步分析失败', '初步分析或导出未完成；已保存案情与材料保留。')
    console.error(`初步分析未完成，已保存材料保留在 ${root}。${error instanceof Error ? error.message : '未知错误'}`)
    process.exitCode = 1
  } finally { runtime?.close(); budget.dispose() }
}
