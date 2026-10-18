import { createHash, randomUUID } from 'node:crypto'
import {
  legalSearchQuerySchema, type LegalSearchQuery, type PlannedLegalSearchQuery,
} from '../legalQuery/legalQuerySchema.js'
import { RetrievalError, classifyProviderError } from './retrievalError.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import {
  retrievalProviderResponseSchema,
  type CandidateLegalSource,
  type LegalRetrievalResult,
  type ProviderLegalSource,
} from './retrievalSchema.js'

/** Adapter boundary: no model-generated sources. Implementations search supplied corpus
 * or an actual external data source, and must honor signal where possible.
 * Return unknown so even typed adapters undergo runtime validation.
 */
export interface LegalRetrievalProvider {
  readonly id: string
  /** Provider-specific request projection; canonical query IDs and text must remain unchanged. */
  formulateQueryPlans?(plans: PlannedLegalSearchQuery[], questions?: readonly LegalQuestion[]): PlannedLegalSearchQuery[]
  /** Opt-in only: return a stable, non-secret identity for an exactly equivalent request. */
  requestIdentity?(query: LegalSearchQuery): string | undefined
  search(query: LegalSearchQuery, signal: AbortSignal): Promise<unknown>
}

export interface LegalRetriever {
  readonly providerId?: string
  providerIdForQuery?(query: LegalSearchQuery): string
  formulateQueryPlans?(plans: PlannedLegalSearchQuery[], questions?: readonly LegalQuestion[]): PlannedLegalSearchQuery[]
  requestIdentity?(query: LegalSearchQuery): string | undefined
  retrieve(query: LegalSearchQuery): Promise<LegalRetrievalResult>
}

export function validateRetrievalQuery(query: LegalSearchQuery): LegalSearchQuery {
  const parsed = legalSearchQuerySchema.safeParse(query)
  if (!parsed.success) {
    throw new RetrievalError('INVALID_INPUT', 'Retrieval query failed schema validation', { cause: parsed.error })
  }
  const value = parsed.data
  if ([value.id, value.legalQuestionId, value.query, ...value.keywords, ...value.legalConcepts]
    .some((text) => !text.trim())) {
    throw new RetrievalError('INVALID_INPUT', 'Retrieval query contains blank fields')
  }
  return value
}

/** Explicit ordered serialization preserves exact text/URL/locator and excludes ranking.
 * No URL-only deduplication: different passages or snapshots must remain distinct.
 */
function sourceSnapshot(source: ProviderLegalSource): string {
  return JSON.stringify([
    source.providerSourceId, source.sourceType, source.title, source.content,
    source.sourceOrigin, source.sourceUrl ?? null, source.locator ?? null,
    ...(source.authority ? [source.authority] : []),
  ])
}

export class ProviderLegalRetriever implements LegalRetriever {
  readonly providerId: string
  private readonly timeoutMs: number

  constructor(
    private readonly provider: LegalRetrievalProvider,
    options: { timeoutMs?: number } = {},
  ) {
    if (typeof provider.id !== 'string' || !provider.id.trim() || typeof provider.search !== 'function') {
      throw new RetrievalError('INVALID_INPUT', 'Retrieval provider requires an id and search method')
    }
    this.providerId = provider.id
    this.timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new RetrievalError('INVALID_INPUT', 'Retrieval timeout must be a positive supported integer')
    }
  }

  formulateQueryPlans(plans: PlannedLegalSearchQuery[], questions?: readonly LegalQuestion[]): PlannedLegalSearchQuery[] {
    return this.provider.formulateQueryPlans?.(structuredClone(plans), questions && structuredClone(questions)) ?? structuredClone(plans)
  }

  requestIdentity(query: LegalSearchQuery): string | undefined {
    if (!this.provider.requestIdentity) return undefined
    const identity = this.provider.requestIdentity(structuredClone(validateRetrievalQuery(query)))
    if (identity === undefined) return undefined
    if (typeof identity !== 'string' || !identity.trim()) {
      throw new RetrievalError('INVALID_INPUT', 'Retrieval provider returned an invalid request identity')
    }
    return JSON.stringify(['retrieval-request-v1', this.providerId, identity])
  }

  async retrieve(query: LegalSearchQuery): Promise<LegalRetrievalResult> {
    const input = validateRetrievalQuery(query)
    // Capture provenance before invoking the adapter; give it a separate copy.
    const retrievalId = `retrieval-${randomUUID()}`
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RetrievalError('TIMEOUT', `Retrieval timed out after ${this.timeoutMs}ms`))
          controller.abort()
        }, this.timeoutMs)
      })
      const operation = Promise.resolve()
        .then(() => this.provider.search(structuredClone(input), controller.signal))
        .catch((error: unknown) => {
          throw classifyProviderError(error)
        })
      // Race also bounds adapters that ignore cancellation. No retry or fallback.
      const response = await Promise.race([operation, deadline])
      const parsed = retrievalProviderResponseSchema.safeParse(response)
      if (!parsed.success) {
        throw new RetrievalError('INVALID_RESPONSE', 'Retrieval provider returned malformed data', {
          cause: parsed.error,
        })
      }

      const seen = new Map<string, string>()
      const sources: CandidateLegalSource[] = []
      for (const record of parsed.data.sources) {
        const snapshot = sourceSnapshot(record)
        const previous = seen.get(record.providerSourceId)
        if (previous !== undefined) {
          if (previous !== snapshot) {
            throw new RetrievalError('INVALID_RESPONSE', 'Retrieval provider returned conflicting source identities')
          }
          continue // Same record/snapshot: keep the first provider-ranked occurrence.
        }
        seen.set(record.providerSourceId, snapshot)
        const digest = createHash('sha256').update(JSON.stringify([this.providerId, snapshot])).digest('hex')
        sources.push({
          sourceId: `source-${digest}`,
          verificationStatus: 'UNVERIFIED',
          contentTrust: 'UNTRUSTED',
          record,
        })
      }
      if (process.env.RESEARCH_RETRIEVAL_DEBUG === '1' && this.providerId === 'supreme-court-public-search-v1') {
        console.error('[supreme-court-search]', JSON.stringify({ phase: 'final-sources', queryId: input.id,
          complete: parsed.data.complete, beforeFiltering: parsed.data.sources.length, afterFiltering: sources.length,
          filteredCount: parsed.data.sources.length - sources.length, filterReason: 'Exact duplicate provider record snapshots only' }))
      }
      return {
        retrievalId,
        legalQuestionId: input.legalQuestionId,
        legalSearchQueryId: input.id,
        providerId: this.providerId,
        retrievedAt: new Date().toISOString(),
        complete: parsed.data.complete,
        ...(parsed.data.access ? { access: parsed.data.access } : {}),
        ...(parsed.data.queryDiagnostics ? { queryDiagnostics: parsed.data.queryDiagnostics } : {}),
        sources,
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
