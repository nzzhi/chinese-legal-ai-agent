import { z } from 'zod'
import type { LegalSearchQuery } from '../legalQuery/legalQuerySchema.js'
import { validateRetrievalQuery, type LegalRetrievalProvider } from './legalRetriever.js'
import { RetrievalError } from './retrievalError.js'
import { providerLegalSourceSchema, type ProviderLegalSource, type RetrievalProviderResponse } from './retrievalSchema.js'

/** Minimal deterministic corpus adapter, not a production Chinese search engine.
 * No default corpus, generated laws, network access or model calls.
 * Matching uses literal query terms, keywords and concepts; any match is a candidate.
 */
export class InMemoryLegalRetrievalProvider implements LegalRetrievalProvider {
  private readonly corpus: ProviderLegalSource[]

  constructor(public readonly id: string, corpus: readonly ProviderLegalSource[]) {
    const parsed = z.array(providerLegalSourceSchema).safeParse(corpus)
    if (!id.trim() || !parsed.success) {
      throw new RetrievalError('INVALID_INPUT', 'In-memory corpus or provider id is invalid')
    }
    const ids = new Set<string>()
    for (const record of parsed.data) {
      if (ids.has(record.providerSourceId)) {
        throw new RetrievalError('INVALID_INPUT', 'In-memory corpus contains duplicate source ids')
      }
      ids.add(record.providerSourceId)
    }
    this.corpus = parsed.data
  }

  async search(query: LegalSearchQuery, signal: AbortSignal): Promise<RetrievalProviderResponse> {
    signal.throwIfAborted()
    const input = validateRetrievalQuery(query)
    const terms = [...new Set([
      ...input.query.split(/\s+/), ...input.keywords, ...input.legalConcepts,
    ].map((term) => term.trim().toLowerCase()).filter(Boolean))]
    const sources = this.corpus.filter((record) => {
      const text = `${record.title}\n${record.content}`.toLowerCase()
      return terms.some((term) => text.includes(term))
    })
    return { complete: true, sources: structuredClone(sources) }
  }
}

