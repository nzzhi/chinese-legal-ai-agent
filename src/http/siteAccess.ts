export interface SiteAccessMetadata {
  cacheStatus: 'HIT' | 'MISS'
  storedAt: string
  expiresAt?: string
}

export class SiteAccessError extends Error {
  constructor(
    public readonly code: 'ACCESS_RESTRICTED',
    message: string,
    public readonly origin: string,
    public readonly httpStatus?: number,
    public readonly retryAfter?: string,
  ) {
    super(message)
    this.name = 'SiteAccessError'
  }
}

interface CachedResponse {
  bytes: Uint8Array
  status: number
  statusText: string
  headers: [string, string][]
  url: string
  redirected: boolean
  storedAt: number
  expiresAt: number
}

interface SiteState {
  tail: Promise<void>
  lastStartedAt: number
  restriction?: SiteAccessError
}

export interface SiteAccessOptions {
  minIntervalMs?: number
  cacheTtlMs?: number
  maxCacheEntries?: number
  maxCacheResponseBytes?: number
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

const metadata = new WeakMap<Response, SiteAccessMetadata>()

export function getSiteAccessMetadata(response: Response): SiteAccessMetadata | undefined {
  return metadata.get(response)
}

/** Per-process public-site guard: one in-flight request per origin, conservative
 * spacing, a run-scoped access-restriction circuit, and a bounded in-memory cache.
 */
export class SiteAccessManager {
  private readonly minIntervalMs: number
  private readonly cacheTtlMs: number
  private readonly maxCacheEntries: number
  private readonly maxCacheResponseBytes: number
  private readonly now: () => number
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly sites = new Map<string, SiteState>()
  private readonly cache = new Map<string, CachedResponse>()

  constructor(options: SiteAccessOptions = {}) {
    this.minIntervalMs = integerOption(options.minIntervalMs, 1_000, 'Site request interval', 0)
    this.cacheTtlMs = integerOption(options.cacheTtlMs, 5 * 60_000, 'Site cache TTL', 1)
    this.maxCacheEntries = integerOption(options.maxCacheEntries, 128, 'Site cache entry limit', 1)
    this.maxCacheResponseBytes = integerOption(options.maxCacheResponseBytes, 512_000, 'Site cache response limit', 1)
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? abortableDelay
  }

  createFetch(delegate: typeof fetch = fetch): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => this.fetch(input, init, delegate)) as typeof fetch
  }

  private async fetch(input: RequestInfo | URL, init: RequestInit | undefined, delegate: typeof fetch): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const state = this.state(url.origin)
    this.assertAllowed(state)
    const key = cacheKey(request, init)
    const cached = this.cached(key)
    if (cached) return responseFromCache(cached)

    let release!: () => void
    const turn = state.tail
    state.tail = new Promise<void>((resolve) => { release = resolve })
    try {
      await waitForTurn(turn, request.signal)
    } catch (error) {
      void turn.finally(release)
      throw error
    }

    try {
      this.assertAllowed(state)
      const queuedCache = this.cached(key)
      if (queuedCache) return responseFromCache(queuedCache)
      const remaining = this.minIntervalMs - (this.now() - state.lastStartedAt)
      if (remaining > 0) await this.sleep(remaining, request.signal)
      if (request.signal.aborted) throw abortError()
      state.lastStartedAt = this.now()
      const response = await delegate(input, init)
      const storedAt = this.now()
      const retryAfter = validRetryAfter(response.headers.get('retry-after'))
      if ([401, 403, 429].includes(response.status)) {
        void response.body?.cancel().catch(() => {})
        throw this.restrict(state, url.origin, `Public site returned HTTP ${response.status}`, response.status, retryAfter)
      }

      const snapshot = response.status === 200
        ? await snapshotResponse(response, request.signal, this.maxCacheResponseBytes)
        : undefined
      if (request.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        throw abortError()
      }
      if (snapshot && isExplicitAccessRestrictionPage(new TextDecoder('utf-8').decode(snapshot.bytes), response.headers.get('content-type'))) {
        void response.body?.cancel().catch(() => {})
        throw this.restrict(state, url.origin, 'Public site returned an access verification or restriction page')
      }

      const access: SiteAccessMetadata = { cacheStatus: 'MISS', storedAt: new Date(storedAt).toISOString() }
      if (snapshot && request.method === 'GET' && /^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        const expiresAt = storedAt + this.cacheTtlMs
        this.cache.set(key, {
          ...snapshot, status: response.status, statusText: response.statusText,
          headers: [...response.headers.entries()], url: response.url || url.href,
          redirected: response.redirected, storedAt, expiresAt,
        })
        access.expiresAt = new Date(expiresAt).toISOString()
        while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!)
      }
      metadata.set(response, access)
      return response
    } finally {
      release()
    }
  }

  private state(origin: string): SiteState {
    let state = this.sites.get(origin)
    if (!state) {
      state = { tail: Promise.resolve(), lastStartedAt: Number.NEGATIVE_INFINITY }
      this.sites.set(origin, state)
    }
    return state
  }

  private assertAllowed(state: SiteState): void {
    if (state.restriction) throw state.restriction
  }

  private restrict(state: SiteState, origin: string, reason: string, status?: number, retryAfter?: string): SiteAccessError {
    const suffix = retryAfter ? `; Retry-After: ${retryAfter}` : ''
    const error = new SiteAccessError('ACCESS_RESTRICTED', `${reason}${suffix}`, origin, status, retryAfter)
    state.restriction = error
    return error
  }

  private cached(key: string): CachedResponse | undefined {
    const value = this.cache.get(key)
    if (!value) return undefined
    if (value.expiresAt <= this.now()) {
      this.cache.delete(key)
      return undefined
    }
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }
}

function integerOption(value: number | undefined, fallback: number, label: string, minimum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}`)
  return result
}

function cacheKey(request: Request, init: RequestInit | undefined): string {
  const headers = new Headers(init?.headers ?? request.headers)
  return JSON.stringify(['site-response-v1', request.method, request.url, init?.redirect ?? request.redirect, headers.get('accept') ?? ''])
}

async function snapshotResponse(
  response: Response, signal: AbortSignal, maximum: number,
): Promise<Pick<CachedResponse, 'bytes'> | undefined> {
  if (!response.body) return undefined
  const declared = response.headers.get('content-length')
  if (declared && (/^\d+$/.test(declared) ? Number(declared) : maximum + 1) > maximum) return undefined
  const reader = response.clone().body!.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw abortError()
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maximum) { cancel(); return undefined }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { bytes }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

function responseFromCache(value: CachedResponse): Response {
  const response = new Response(value.bytes.slice(), {
    status: value.status, statusText: value.statusText, headers: value.headers,
  })
  Object.defineProperty(response, 'url', { value: value.url })
  Object.defineProperty(response, 'redirected', { value: value.redirected })
  metadata.set(response, {
    cacheStatus: 'HIT', storedAt: new Date(value.storedAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(),
  })
  return response
}

export function isExplicitAccessRestrictionPage(html: string, contentType?: string | null): boolean {
  if (!/text\/html/i.test(contentType ?? '') && !/^\s*</.test(html.slice(0, 64))) return false
  return /<title[^>]*>[^<]*(?:验证码|访问受限|安全验证|access denied|just a moment)/iu.test(html)
    || /(?:id|class)=["'][^"']*(?:captcha|challenge|waf|verify)[^"']*["']/iu.test(html)
    || /(?:请输入.{0,12}验证码|访问过于频繁|请求过于频繁|请完成.{0,8}(?:安全|人机)验证)/u.test(html)
}

async function waitForTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError()
  let rejectAbort!: (error: Error) => void
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(abortError())
  signal.addEventListener('abort', onAbort, { once: true })
  try { await Promise.race([turn, cancelled]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError()) }
    function cleanup() { signal?.removeEventListener('abort', onAbort) }
    function done() { cleanup(); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  return new DOMException('Site request cancelled', 'AbortError')
}

function validRetryAfter(value: string | null): string | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed) || Number.isFinite(Date.parse(trimmed))) return trimmed
  return undefined
}
