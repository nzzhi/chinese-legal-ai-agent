import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ModelClient, ModelRequest } from '../llm/modelClient.js'
import type { ConditionalAnalysisInput, ConditionalQuestionAnalysis } from '../legalRule/conditionalAnalysis.js'
import { validatedConditionalResearch } from '../report/conditionalResearchReport.js'
import { checkedInput } from '../legalRule/conditionalAnalysis.js'
import { parseModelJson } from '../llm/modelJson.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const responseSchema = z.strictObject({ text: z.string().max(2_000_000), model: z.string().min(1), finishReason: z.literal('STOP') })
const entrySchema = z.strictObject({ at: z.number(), response: responseSchema })
const stableInput = (input: ConditionalAnalysisInput) => ({ ...input, candidateVerifications: input.candidateVerifications.map(v => ({ ...v,
  retrieval: { ...v.retrieval, retrievalId: '', retrievedAt: '' },
  result: { ...v.result, retrievalId: '', verificationId: '', checkedAt: '',
    verifiedSource: v.result.verifiedSource ? { ...v.result.verifiedSource, verificationId: '', verifiedAt: '' } : undefined },
})) })

/** Exact request/snapshot reuse only; cached outputs still pass the normal production validators. */
export class ResearchCache {
  constructor(private readonly root: string, private readonly signal: AbortSignal, private readonly reuse = true) {}
  private async read(name: string) {
    try { return JSON.parse(await readFile(join(this.root, name), 'utf8')) as unknown }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  private async write(name: string, value: unknown, requestSignal?: AbortSignal) {
    this.signal.throwIfAborted(); requestSignal?.throwIfAborted()
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = join(this.root, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
      this.signal.throwIfAborted(); requestSignal?.throwIfAborted()
      await rename(temporary, join(this.root, name))
    } finally { await rm(temporary, { force: true }) }
  }
  model(client: ModelClient, onReuse?: () => void): ModelClient {
    return { chat: async (request: ModelRequest) => {
      this.signal.throwIfAborted(); request.signal?.throwIfAborted()
      // Diagnostic target IDs stay local; they are not part of the provider's semantic request.
      const { signal: _signal, diagnosticContext: _diagnosticContext, ...payload } = request
      const key = `model-${hash(payload)}.json`
      const cached = this.reuse ? await this.read(key) : undefined
      if (cached !== undefined) {
        const entry = entrySchema.parse(cached)
        if (Date.now() - entry.at < 86_400_000 && entry.at <= Date.now()) {
          this.signal.throwIfAborted(); request.signal?.throwIfAborted(); onReuse?.(); return entry.response
        }
      }
      const result = await client.chat(request)
      request.signal?.throwIfAborted()
      // Incomplete/unknown output never becomes a resumable response; old usage is never charged again.
      if (result.finishReason === 'STOP') {
        let parsed = true
        try { parseModelJson(result.text) } catch { parsed = false }
        if (parsed) await this.write(key, { at: Date.now(), response: responseSchema.parse({ text: result.text, model: result.model, finishReason: result.finishReason }) }, request.signal)
      }
      return result
    } }
  }
  async load(input: ConditionalAnalysisInput): Promise<ConditionalQuestionAnalysis[]> {
    if (!this.reuse) return []
    const results: ConditionalQuestionAnalysis[] = []
    for (const question of input.legalQuestions) {
      const saved = await this.read(`question-${hash([stableInput(input), question.id])}.json`)
      if (saved === undefined) continue
      const entry = z.object({ at: z.number(), input: z.unknown(), result: z.unknown() }).parse(saved)
      if (Date.now() - entry.at >= 86_400_000 || entry.at > Date.now()) continue
      const old = entry.input as ConditionalAnalysisInput
      checkedInput(old)
      if (hash(stableInput(old)) !== hash(stableInput(input))) throw new Error('Checkpoint snapshot mismatch')
      validatedConditionalResearch({ ...old, conditionalAnalysis: { caseSnapshotId: old.caseSnapshotId, questions: [entry.result] } })
      // Only fresh verification identities change. Source bytes/metadata/checks and query provenance must match exactly.
      const verificationIds = new Map(old.candidateVerifications.map((v, i) => [v.result.verificationId, input.candidateVerifications[i].result.verificationId]))
      const rebind = (value: unknown): unknown => Array.isArray(value) ? value.map(rebind)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
          key === 'verificationId' && typeof item === 'string' ? verificationIds.get(item) ?? item : rebind(item)])) : value
      // Re-check exact citations, independent Entailment and Application, never trust serialized types.
      const report = validatedConditionalResearch({ ...input, conditionalAnalysis: { caseSnapshotId: input.caseSnapshotId, questions: [rebind(entry.result)] } })!
      const validated = report.questions.find(q => q.question.id === question.id)?.analysis
      if (validated) results.push(validated)
    }
    return results
  }
  async save(input: ConditionalAnalysisInput, result: ConditionalQuestionAnalysis) {
    validatedConditionalResearch({ ...input, conditionalAnalysis: { caseSnapshotId: input.caseSnapshotId, questions: [result] } })
    await this.write(`question-${hash([stableInput(input), result.legalQuestionId])}.json`, { at: Date.now(), input, result })
  }
}
