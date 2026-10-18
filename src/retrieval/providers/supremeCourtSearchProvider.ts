import type {
  LegalSearchQuery, PlannedLegalSearchQuery, ProviderQueryFamily,
} from '../../legalQuery/legalQuerySchema.js'
import { canonicalLegalDomain } from '../../legalQuery/fallbackGrounding.js'
import { getSiteAccessMetadata, isExplicitAccessRestrictionPage, SiteAccessError } from '../../http/siteAccess.js'
import { validateRetrievalQuery, type LegalRetrievalProvider } from '../legalRetriever.js'
import { RetrievalError, classifyProviderError } from '../retrievalError.js'
import { parseSupremeCourtSearch, supremeCourtLimits, supremeCourtOrigin } from './supremeCourtSearchParser.js'

/** Public HTML search, one request, no retries/pagination/detail crawling.
 * Inject fetch for offline fixtures. Always consume through ProviderLegalRetriever.
 */
export class SupremeCourtSearchProvider implements LegalRetrievalProvider {
  readonly id = 'supreme-court-public-search-v1'
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetcher = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new RetrievalError('INVALID_INPUT', 'Official search timeout must be a positive supported integer')
    }
  }

  formulateQueryPlans(plans: PlannedLegalSearchQuery[]): PlannedLegalSearchQuery[] {
    const domains = new Set(plans.filter(plan => plan.sourcePurpose !== 'REFERENCE')
      .map(plan => canonicalLegalDomain(queryVocabulary(plan))).filter((domain): domain is string => domain !== undefined))
    const sharedDomain = domains.size === 1 ? [...domains][0] : undefined
    return plans.map(plan => formulateSupremeCourtQueryPlan(plan, sharedDomain))
  }

  requestIdentity(query: LegalSearchQuery): string {
    const input = validateRetrievalQuery(query)
    const providerQuery = input.providerQuery ?? input.query
    if (providerQuery.length > 500) throw new RetrievalError('INVALID_INPUT', 'Official search query exceeds 500 characters')
    return `GET ${supremeCourtSearchUrl(providerQuery).href}`
  }

  async search(query: LegalSearchQuery, signal: AbortSignal): Promise<unknown> {
    const debug = process.env.RESEARCH_RETRIEVAL_DEBUG === '1'
      ? (data: Record<string, unknown>) => console.error('[supreme-court-search]', JSON.stringify({ queryId: query.id, ...data }))
      : undefined
    const input = validateRetrievalQuery(query)
    const providerQuery = input.providerQuery ?? input.query
    if (providerQuery.length > 500) throw new RetrievalError('INVALID_INPUT', 'Official search query exceeds 500 characters')
    const url = supremeCourtSearchUrl(providerQuery)
    debug?.({ phase: 'request', url: url.href, parameters: { content: providerQuery }, method: 'GET' })
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAbort: (() => void) | undefined
    try {
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new RetrievalError('TIMEOUT', 'Official search timed out or was cancelled'))
        controller.signal.addEventListener('abort', rejectAbort, { once: true })
      })
      signal.addEventListener('abort', forwardAbort, { once: true })
      if (signal.aborted) controller.abort()
      timer = setTimeout(() => controller.abort(), this.timeoutMs)
      const operation = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw new RetrievalError('TIMEOUT', 'Official search cancelled')
        try {
          const response = await this.fetcher(url, {
            method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { accept: 'text/html', 'user-agent': 'ChineseLegalResearchAgent/0.1 (single-page research retrieval)' },
          })
          const cancelBody = () => { void response.body?.cancel().catch(() => {}) }
          debug?.({ phase: 'http', status: response.status, contentType: response.headers.get('content-type'), declaredLength: response.headers.get('content-length') })
          if (controller.signal.aborted) { cancelBody(); throw new RetrievalError('TIMEOUT', 'Official search cancelled') }
          if (response.status !== 200) {
            cancelBody()
            const code = [401, 403, 429].includes(response.status) ? 'ACCESS_RESTRICTED'
              : response.status >= 500 && response.status <= 599 ? 'HTTP_SERVER_ERROR' : 'PROVIDER_ERROR'
            throw new RetrievalError(code, `Official search returned HTTP ${response.status}`)
          }
          // Fetch rejects redirects in production; also reject mocked/unexpected final URLs.
          if (response.redirected || (response.url && response.url !== url.href)) {
            cancelBody()
            throw new RetrievalError('INVALID_RESPONSE', 'Official search response URL changed')
          }
          if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
            cancelBody()
            throw new RetrievalError('INVALID_RESPONSE', 'Official search did not return HTML')
          }
          const length = response.headers.get('content-length')
          if (length && (!/^\d+$/.test(length) || Number(length) > supremeCourtLimits.maxResponseBytes)) {
            cancelBody()
            throw new RetrievalError('INVALID_RESPONSE', 'Official search response exceeds byte limit')
          }
          const html = await readLimitedHtml(response, controller.signal)
          if (isExplicitAccessRestrictionPage(html, response.headers.get('content-type'))) {
            throw new RetrievalError('ACCESS_RESTRICTED', 'Official search returned an access verification or restriction page')
          }
          debug?.({ phase: 'body', characters: html.length, utf8Bytes: Buffer.byteLength(html, 'utf8') })
          const result = parseSupremeCourtSearch(html, url.href, debug)
          if (result.complete && result.sources.length === 0) {
            debug?.({ phase: 'zero-results', reason: 'Official HTML reports zero records; no local candidate removal',
              multiTermQuery: /\s/.test(providerQuery),
              note: 'The endpoint does not guarantee space-separated keyword conjunction; provider family fallback is external to this request' })
          }
          const access = getSiteAccessMetadata(response)
          return access ? { ...result, access } : result
        } catch (error) {
          debug?.({ phase: 'error', reason: error instanceof RetrievalError ? error.message : 'Network or response processing failed' })
          if (error instanceof SiteAccessError) {
            throw new RetrievalError('ACCESS_RESTRICTED', error.message, { cause: error })
          }
          throw classifyProviderError(error)
        }
      })
      return await Promise.race([operation, cancelled])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', forwardAbort)
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    }
  }
}

const actionVocabulary: ReadonlyArray<readonly [RegExp, string]> = [
  [/返还(?:剩余)?预付款|预付款返还|退款|退费|退还/u, '返还预付款'],
  [/合同解除|解除|终止/u, '合同解除'],
  [/举证责任/u, '举证责任'],
  [/合同解释/u, '合同解释'],
]

/** Closed provider vocabulary: broad recall first, relevance remains a later verification concern. */
export function formulateSupremeCourtQueryPlan(
  plan: PlannedLegalSearchQuery,
  sharedDomain?: string,
): PlannedLegalSearchQuery {
  if (plan.sourcePurpose === 'REFERENCE') return structuredClone(plan)
  const vocabulary = queryVocabulary(plan)
  const domain = canonicalLegalDomain(vocabulary) ?? sharedDomain
  if (!domain) return { ...structuredClone(plan), fallbackQueries: structuredClone(plan.fallbackQueries.slice(0, 2)) }
  const action = actionVocabulary.find(([pattern]) => pattern.test(vocabulary))?.[1]
  const family: Array<readonly [ProviderQueryFamily, string]> = [
    ['DOMAIN', domain],
    ...(action ? [['DOMAIN_ACTION', `${domain} ${action}`] as const] : []),
    ['AUTHORITY_FALLBACK', `${domain} 司法解释`],
  ]
  const slots = [plan, ...plan.fallbackQueries]
  const projected = slots.slice(0, family.length).map((query, index) => ({
    ...query, providerQueryFamily: family[index]![0], providerQuery: family[index]![1],
  }))
  const [primary, ...fallbackQueries] = projected
  return { ...primary!, fallbackQueries, fallbackRejections: plan.fallbackRejections }
}

function queryVocabulary(plan: PlannedLegalSearchQuery): string {
  return [plan, ...plan.fallbackQueries]
    .flatMap(query => [query.query, ...query.keywords, ...query.legalConcepts]).join(' ')
}

function supremeCourtSearchUrl(query: string): URL {
  const url = new URL('/search.html', supremeCourtOrigin)
  url.searchParams.set('content', query)
  return url
}

async function readLimitedHtml(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new RetrievalError('INVALID_RESPONSE', 'Official search response body missing')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let html = ''
  try {
    while (true) {
      if (signal.aborted) throw new RetrievalError('TIMEOUT', 'Official search body cancelled')
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > supremeCourtLimits.maxResponseBytes) throw new RetrievalError('INVALID_RESPONSE', 'Official search response exceeds byte limit')
      try { html += decoder.decode(chunk.value, { stream: true }) }
      catch (error) { throw new RetrievalError('INVALID_RESPONSE', 'Official search response is not UTF-8', { cause: error }) }
      if (html.length > supremeCourtLimits.maxHtmlChars) throw new RetrievalError('INVALID_RESPONSE', 'Official search response exceeds character limit')
    }
    try { html += decoder.decode() }
    catch (error) { throw new RetrievalError('INVALID_RESPONSE', 'Official search response contains incomplete UTF-8', { cause: error }) }
    return html
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}
