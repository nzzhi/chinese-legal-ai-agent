import { createHash } from 'node:crypto'
import { getSiteAccessMetadata, isExplicitAccessRestrictionPage, SiteAccessError } from '../../http/siteAccess.js'
import { SourceVerificationError } from '../sourceVerificationError.js'

export const supremeCourtVerificationOrigin = 'https://www.court.gov.cn'
export const supremeCourtDetailHttpLimits = {
  maxResponseBytes: 256_000,
  maxHtmlChars: 128_000,
  maxRedirects: 2,
} as const

export interface DetailFetchResult {
  requestedUrl: string
  finalUrl?: string
  httpStatus?: number
  contentType?: string
  fetchedAt: string
  cacheStatus?: 'HIT' | 'MISS'
  cacheExpiresAt?: string
  responseBodyHash?: string
  responseBytes?: number
  html?: string
  extractedProviderSourceId?: string
  identityMismatch?: string
  redirects: Array<{ url: string; status: number; location: string }>
}

/** Check the raw path before URL parsing can silently remove dot segments.
 * Only host/scheme case and the default HTTPS port may canonicalize.
 */
export function parseSupremeCourtDetailUrl(value: string): { url: string; providerSourceId: string } | undefined {
  if (typeof value !== 'string' || /[\s\u0000-\u0020\u007f-\u009f\\%?#]/u.test(value)) return undefined
  const raw = /^https:\/\/(www\.court\.gov\.cn(?::443)?)(\/.*)$/i.exec(value)
  if (!raw) return undefined
  const path = /^\/([a-z]+)\/xiangqing\/(\d+)\.html$/.exec(raw[2])
  if (!path) return undefined
  try {
    const url = new URL(value)
    if (url.origin !== supremeCourtVerificationOrigin || url.username || url.password) return undefined
    return { url: url.href, providerSourceId: `${path[1]}:${path[2]}` }
  } catch { return undefined }
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new SourceVerificationError('CANCELLED', 'Official detail request cancelled')
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

function redirectTarget(location: string): ReturnType<typeof parseSupremeCourtDetailUrl> {
  // Root-relative Location is supported without allowing URL to normalize its path.
  return parseSupremeCourtDetailUrl(location.startsWith('/') && !location.startsWith('//')
    ? supremeCourtVerificationOrigin + location : location)
}

/** Fetch only the requested official article. The verifier owns the timeout/race.
 * Never retries, crawls links, loads attachments or upgrades content trust.
 */
export async function fetchSupremeCourtDetail(
  requestedUrl: string,
  expectedProviderSourceId: string,
  options: { fetch: typeof fetch; signal: AbortSignal },
): Promise<DetailFetchResult> {
  const result: DetailFetchResult = { requestedUrl, fetchedAt: new Date().toISOString(), redirects: [] }
  cancelled(options.signal)
  const requested = parseSupremeCourtDetailUrl(requestedUrl)
  if (!requested || requested.providerSourceId !== expectedProviderSourceId) {
    return { ...result, identityMismatch: 'Requested URL does not match the allowed origin and candidate identity' }
  }
  let currentUrl = requested.url
  const visited = new Set<string>()
  try {
    while (true) {
      cancelled(options.signal)
      visited.add(currentUrl)
      let response: Response
      try {
        response = await options.fetch(currentUrl, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal: options.signal,
          headers: { accept: 'text/html', 'user-agent': 'ChineseLegalResearchAgent/0.1 (single-page source verification)' },
        })
      } catch (error) {
        cancelled(options.signal)
        if (error instanceof SiteAccessError) {
          throw new SourceVerificationError('ACCESS_RESTRICTED', error.message, { cause: error })
        }
        throw new SourceVerificationError('NETWORK_ERROR', 'Official detail network request failed', { cause: error })
      }
      if (options.signal.aborted) { cancelBody(response); cancelled(options.signal) }
      const access = getSiteAccessMetadata(response)
      result.fetchedAt = access?.storedAt ?? new Date().toISOString()
      result.cacheStatus = access?.cacheStatus
      result.cacheExpiresAt = access?.expiresAt
      result.httpStatus = response.status
      result.contentType = response.headers.get('content-type') ?? undefined
      result.finalUrl = response.url || undefined
      const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
      const location = response.headers.get('location') ?? ''
      if (isRedirect) result.redirects.push({ url: currentUrl, status: response.status, location })
      const actual = parseSupremeCourtDetailUrl(response.url)
      if (!actual || actual.providerSourceId !== expectedProviderSourceId || response.redirected) {
        cancelBody(response)
        result.identityMismatch = 'Actual response URL is missing, unexpected, or has an untracked redirect'
        return result
      }
      result.finalUrl = actual.url
      result.extractedProviderSourceId = actual.providerSourceId
      if (isRedirect) {
        cancelBody(response)
        const next = redirectTarget(location)
        if (!next || next.providerSourceId !== expectedProviderSourceId) {
          result.identityMismatch = 'Redirect target does not match the allowed origin and candidate identity'
          return result
        }
        if (result.redirects.length > supremeCourtDetailHttpLimits.maxRedirects || visited.has(next.url)) {
          result.identityMismatch = 'Redirect limit or redirect loop detected'
          return result
        }
        currentUrl = next.url
        continue
      }
      if (response.status === 404 || response.status === 410) { cancelBody(response); return result }
      if ([401, 403, 429].includes(response.status)) {
        cancelBody(response)
        throw new SourceVerificationError('ACCESS_RESTRICTED', `Official detail returned HTTP ${response.status}`)
      }
      if (response.status === 206 || response.headers.has('content-range')) {
        cancelBody(response)
        throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail returned a partial response')
      }
      if (response.status !== 200) {
        cancelBody(response)
        throw new SourceVerificationError('NETWORK_ERROR', `Official detail returned HTTP ${response.status}`)
      }
      if (!isUtf8Html(result.contentType)) {
        cancelBody(response)
        throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail must return UTF-8 HTML')
      }
      const lengthHeader = response.headers.get('content-length')
      let expectedBytes: number | undefined
      if (lengthHeader !== null) {
        expectedBytes = Number(lengthHeader)
        if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(expectedBytes) || expectedBytes > supremeCourtDetailHttpLimits.maxResponseBytes) {
          cancelBody(response)
          throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail Content-Length is invalid or exceeds byte limit')
        }
      }
      const body = await readLimitedHtml(response, options.signal, response.headers.get('content-encoding') ? undefined : expectedBytes)
      if (isExplicitAccessRestrictionPage(body.html, result.contentType)) {
        throw new SourceVerificationError('ACCESS_RESTRICTED', 'Official detail returned an access verification or restriction page')
      }
      return { ...result, ...body }
    }
  } catch (error) {
    if (error instanceof SourceVerificationError) {
      const { html: _html, identityMismatch: _mismatch, ...evidence } = result
      error.evidence = evidence
    }
    throw error
  }
}

function isUtf8Html(contentType: string | undefined): boolean {
  if (!contentType) return false
  const parts = contentType.split(';')
  if (parts.shift()?.trim().toLowerCase() !== 'text/html') return false
  // An absent charset is accepted only when the complete bytes decode as UTF-8.
  let seenCharset = false
  for (const part of parts) {
    if (!/^\s*charset\b/i.test(part)) continue
    if (seenCharset || !/^\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(part)) return false
    seenCharset = true
  }
  return true
}

async function readLimitedHtml(
  response: Response,
  signal: AbortSignal,
  expectedBytes: number | undefined,
): Promise<{ html: string; responseBytes: number; responseBodyHash: string }> {
  if (!response.body) throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail response body missing')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: Buffer[] = []
  let responseBytes = 0
  let html = ''
  try {
    while (true) {
      cancelled(signal)
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() }
      catch (error) {
        cancelled(signal)
        throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail response stream ended abnormally', { cause: error })
      }
      cancelled(signal)
      if (chunk.done) break
      responseBytes += chunk.value.byteLength
      if (responseBytes > supremeCourtDetailHttpLimits.maxResponseBytes) {
        throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail response exceeds byte limit')
      }
      chunks.push(Buffer.from(chunk.value))
      try { html += decoder.decode(chunk.value, { stream: true }) }
      catch (error) { throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail response is not UTF-8', { cause: error }) }
      if (html.length > supremeCourtDetailHttpLimits.maxHtmlChars) {
        throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail response exceeds HTML character limit')
      }
    }
    try { html += decoder.decode() }
    catch (error) { throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail response contains incomplete UTF-8', { cause: error }) }
    if (html.length > supremeCourtDetailHttpLimits.maxHtmlChars) {
      throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail response exceeds HTML character limit')
    }
    if (expectedBytes !== undefined && expectedBytes !== responseBytes) {
      throw new SourceVerificationError('INVALID_RESPONSE', 'Official detail response does not match Content-Length')
    }
    // Hash the exact received bytes only after a complete successful stream read.
    const responseBodyHash = createHash('sha256').update(Buffer.concat(chunks, responseBytes)).digest('hex')
    return { html, responseBytes, responseBodyHash }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

