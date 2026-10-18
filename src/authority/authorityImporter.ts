import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { AuthorityCorpus } from './authorityCorpus.js'
import { authorityDocumentTypeSchema, authoritySourceConfigSchema, type AuthoritySourceConfig } from './authoritySchema.js'
import { officialAuthorityParsers, parseOfficialAuthorityHtml } from './officialAuthorityParser.js'
import { SiteAccessError, SiteAccessManager } from '../http/siteAccess.js'
import { assertCompleteAuthorityBody } from './authoritySnapshotImporter.js'

export const authoritySeedSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/),
  sourceId: z.string().min(1), title: z.string().min(1), documentType: authorityDocumentTypeSchema,
  issuingAuthority: z.string().min(1), officialUrl: z.string().url(),
  parser: z.enum(officialAuthorityParsers),
  expectedArticleCount: z.number().int().min(1).max(5000).optional(),
})
export type AuthoritySeed = z.infer<typeof authoritySeedSchema>
type ImportStage = 'CACHE' | 'ROBOTS' | 'DETAIL' | 'PARSE' | 'VALIDATE' | 'PERSIST'
interface ImportRequest {
  stage: ImportStage
  url: string
  httpStatus?: number
  location?: string
}
export interface AuthorityImportOutcome {
  documentId: string
  officialUrl: string
  status: 'IMPORTED' | 'CACHED' | 'MANUAL_ONLY' | 'ACCESS_RESTRICTED' | 'NOT_EXECUTED' | 'FAILED'
  articleCount?: number
  validityStatus?: string
  reason?: string
  acquiredSnapshot?: { snapshotHash: string; snapshotPath: string; fetchedAt: string; snapshotFormat: 'HTML' }
  diagnostic?: {
    stage: ImportStage
    requests: ImportRequest[]
    errorChain: Array<{ name: string; message: string; code?: string }>
  }
}
const maxResponseBytes = 2 * 1024 * 1024
const siteKey = (url: string) => {
  const host = new URL(url).hostname
  return host.endsWith('.court.gov.cn') ? 'court.gov.cn' : host
}

function safeMessage(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)[=:]\s*)[^\s&]+/giu, '$1[redacted]').slice(0, 400)
}

export function authorityImportErrorChain(error: unknown) {
  const chain: Array<{ name: string; message: string; code?: string }> = []
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && chain.length < 4 && !seen.has(current)) {
    seen.add(current)
    const code = (current as NodeJS.ErrnoException).code
    chain.push({ name: safeMessage(current.name), message: safeMessage(current.message),
      ...(typeof code === 'string' ? { code: safeMessage(code) } : {}) })
    current = current.cause
  }
  return chain.length ? chain : [{ name: 'UnknownError', message: 'Unknown official import failure' }]
}

/** Conservative applicable robots rules. A matching Disallow wins ties with Allow. */
export function robotsAllows(robots: string, url: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = []
  let group = { agents: [] as string[], rules: [] as Array<{ allow: boolean; path: string }> }
  for (const original of robots.split(/\r?\n/u)) {
    const line = original.replace(/#.*/u, '').trim()
    const match = line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/iu)
    if (!match) continue
    const key = match[1]!.toLowerCase(), value = match[2]!.trim()
    if (key === 'user-agent') {
      if (group.rules.length) { groups.push(group); group = { agents: [], rules: [] } }
      group.agents.push(value.toLowerCase())
    } else if (value && group.agents.length) group.rules.push({ allow: key === 'allow', path: value })
  }
  groups.push(group)
  const requestPath = new URL(url).pathname + new URL(url).search
  const agent = 'chineselegalresearchagent'
  const specific = groups.filter(item => item.agents.some(name => name !== '*' && agent.includes(name)))
  const applicable = specific.length ? specific : groups.filter(item => item.agents.includes('*'))
  const matching = applicable.flatMap(item => item.rules).filter(rule => {
    const pattern = rule.path.replace(/[.+?^{}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')
    return new RegExp('^' + pattern).test(requestPath)
  }).sort((a, b) => b.path.length - a.path.length || Number(a.allow) - Number(b.allow))
  return matching[0]?.allow ?? true
}

function metadata(metadataText: string, bodyText: string) {
  const findDate = (content: string, label: RegExp): string | null => {
    const match = content.match(label)
    return match ? `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}` : null
  }
  const promulgatedAt = findDate(metadataText, /(?:公布日期|发布日期|发文日期|成文日期)[〗】\]：:\s]*(\d{4})[.年\-/](\d{1,2})[.月\-/](\d{1,2})/u)
  const effectiveAt = findDate(metadataText, /(?:施行日期|实施日期|生效日期)[〗】\]：:\s]*(\d{4})[.年\-/](\d{1,2})[.月\-/](\d{1,2})/u)
    ?? findDate(bodyText, /本(?:法|解释|规定)自\s*(\d{4})年(\d{1,2})月(\d{1,2})日(?:起)?施行/u)
  const negative = /废止|失效|无效|尚未生效|部分有效/u.test(metadataText)
  const validityExcerpt = negative ? undefined : metadataText.match(/(?:[〖【]时效性[〗】]\s*现行有效|全文有效|时效状态[：:\s]*现行有效)/u)?.[0]
  return { promulgatedAt, effectiveAt, validityExcerpt }
}

export async function readOfficialResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxResponseBytes)) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Official response exceeds 2MB')
  }
  if (!response.body) throw new Error('Official response body is absent')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxResponseBytes) throw new Error('Official response exceeds 2MB')
      chunks.push(next.value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally { cancel(); reader.releaseLock(); signal.removeEventListener('abort', cancel) }
}

/** Explicit manifest only. Sequential site-shared limits, no pagination, discovery or retries. */
export async function importOfficialAuthorities(
  corpus: AuthorityCorpus,
  manifest: unknown,
  options: { sources: AuthoritySourceConfig[]; limit?: number; fetch?: typeof fetch; access?: SiteAccessManager; now?: () => string },
) {
  const seeds = z.array(authoritySeedSchema).min(1).max(12).parse(manifest)
  const sources = z.array(authoritySourceConfigSchema).min(1).parse(options.sources)
  const limit = options.limit ?? 12
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('Import limit must be between 1 and 12 HTTP requests')
  for (const seed of seeds) {
    const url = new URL(seed.officialUrl)
    const source = sources.find(item => item.id === seed.sourceId)
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !source?.hosts.includes(url.hostname) || !source.documentTypes.includes(seed.documentType)) {
      throw new Error('Seed is outside configured official source/type allowlist')
    }
  }
  const manager = options.access ?? new SiteAccessManager({ minIntervalMs: 1500, maxCacheResponseBytes: maxResponseBytes })
  let requests = 0
  let stage: ImportStage = 'CACHE'
  let trace: ImportRequest[] = []
  const fetcher = manager.createFetch(async (input, init) => {
    if (requests >= limit) throw new Error('IMPORT_REQUEST_LIMIT')
    requests++
    const attempt: ImportRequest = { stage, url: String(input) }
    trace.push(attempt)
    const response = await (options.fetch ?? fetch)(input, init)
    attempt.httpStatus = response.status
    const location = response.headers.get('location')
    if (location) attempt.location = safeMessage(location)
    return response
  })
  const robots = new Map<string, string>()
  const robotsFailures = new Map<string, NonNullable<AuthorityImportOutcome['diagnostic']>>()
  const blocked = new Set<string>()
  const outcomes: AuthorityImportOutcome[] = []
  const now = options.now ?? (() => new Date().toISOString())
  for (const seed of seeds) {
    stage = 'CACHE'
    trace = []
    const outcome: AuthorityImportOutcome = { documentId: seed.id, officialUrl: seed.officialUrl, status: 'FAILED' }
    const source = sources.find(item => item.id === seed.sourceId)!
    const key = siteKey(seed.officialUrl)
    if (source.acquisitionMode === 'MANUAL_ONLY') {
      outcomes.push({ ...outcome, status: 'MANUAL_ONLY', reason: 'Configured official source disallows automated acquisition; provide a controlled official snapshot' })
      continue
    }
    if (blocked.has(key)) {
      outcomes.push({ ...outcome, status: 'ACCESS_RESTRICTED', reason: 'This official site was restricted earlier in this import' })
      continue
    }
    try {
      const cached = corpus.getDocument(seed.id)
      if (cached && cached.officialUrl === seed.officialUrl && cached.title === seed.title) {
        corpus.readSnapshot(cached.id)
        const checkedAt = now()
        const snapshotAge = Date.parse(checkedAt) - Date.parse(cached.fetchedAt)
        const reviewAge = cached.validityEvidence ? Date.parse(checkedAt) - Date.parse(cached.validityEvidence.checkedAt) : snapshotAge
        if (snapshotAge < 0 || reviewAge < 0 || Math.max(snapshotAge, reviewAge) > 30 * 24 * 60 * 60 * 1000) {
          outcomes.push({ ...outcome, status: 'FAILED', reason: 'STALE_SNAPSHOT: prior snapshot/review is older than 30 days or future-dated; explicit refresh or a new controlled snapshot is required' })
          continue
        }
        outcomes.push({ ...outcome, status: 'CACHED', validityStatus: cached.validityStatus,
          reason: 'Reused prior immutable snapshot; fetchedAt and prior review date remain unchanged' })
        continue
      }
      if (requests >= limit) {
        outcomes.push({ ...outcome, status: 'NOT_EXECUTED', reason: 'Import HTTP request budget exhausted before dispatch' })
        continue
      }
      const origin = new URL(seed.officialUrl).origin
      const previousRobotsFailure = robotsFailures.get(origin)
      if (previousRobotsFailure) {
        outcomes.push({ ...outcome, reason: 'Robots check failed earlier for this origin; no repeated HTTP request',
          diagnostic: { ...previousRobotsFailure, requests: [] } })
        continue
      }
      const signal = AbortSignal.timeout(20_000)
      if (!robots.has(origin)) {
        stage = 'ROBOTS'
        const response = await fetcher(new URL('/robots.txt', origin), { redirect: 'manual', signal })
        if (response.status !== 200 && response.status !== 404) {
          void response.body?.cancel().catch(() => {})
          throw new Error(`Robots availability unknown: HTTP ${response.status}`)
        }
        robots.set(origin, response.status === 404 ? '' : await readOfficialResponse(response, signal))
        if (response.status === 404) void response.body?.cancel().catch(() => {})
      }
      if (!robotsAllows(robots.get(origin)!, seed.officialUrl)) {
        blocked.add(key)
        outcomes.push({ ...outcome, status: 'ACCESS_RESTRICTED', reason: 'Applicable robots.txt rule disallows this URL; no detail request was sent',
          diagnostic: { stage: 'ROBOTS', requests: trace, errorChain: [] } })
        continue
      }
      stage = 'DETAIL'
      const response = await fetcher(seed.officialUrl, { redirect: 'manual', signal,
        headers: { accept: 'text/html', 'user-agent': 'ChineseLegalResearchAgent/0.1 (bounded official authority import)' } })
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {})
        throw new Error(`Official detail returned HTTP ${response.status}`)
      }
      if (response.redirected || (response.url && response.url !== seed.officialUrl)
        || !/^text\/html(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {})
        throw new Error('Official response URL or content type changed')
      }
      const html = await readOfficialResponse(response, signal)
      const fetchedAt = now()
      outcome.acquiredSnapshot = { ...corpus.saveSnapshot(html, 'HTML'), fetchedAt, snapshotFormat: 'HTML' }
      stage = 'PARSE'
      const parsed = parseOfficialAuthorityHtml(html, seed.parser, seed.title)
      stage = 'VALIDATE'
      if (seed.expectedArticleCount) assertCompleteAuthorityBody(seed.id, parsed.content, seed.expectedArticleCount)
      const fields = metadata(parsed.metadataText, parsed.content)
      const effective = fields.validityExcerpt && fields.effectiveAt && fields.effectiveAt <= fetchedAt.slice(0, 10)
      stage = 'PERSIST'
      const imported = corpus.importDocument({
        document: { id: seed.id, sourceId: seed.sourceId, title: parsed.title, documentType: seed.documentType,
          issuingAuthority: seed.issuingAuthority, officialUrl: seed.officialUrl, fetchedAt,
          promulgatedAt: fields.promulgatedAt, effectiveAt: fields.effectiveAt,
          validityStatus: effective ? 'EFFECTIVE' : 'UNKNOWN',
          ...(effective ? { validityEvidence: { officialUrl: seed.officialUrl, checkedAt: fetchedAt,
            excerpt: fields.validityExcerpt!, method: 'OFFICIAL_METADATA' as const,
            reason: 'The official snapshot explicitly reports current validity and a past effective date' } } : {}),
        }, bodyText: parsed.content, snapshot: { content: html, format: 'HTML' },
      })
      outcomes.push({ ...outcome, status: 'IMPORTED', articleCount: imported.articles.length,
        validityStatus: imported.document.validityStatus, diagnostic: { stage, requests: trace, errorChain: [] } })
    } catch (error) {
      const diagnostic = { stage, requests: trace, errorChain: authorityImportErrorChain(error) }
      if (error instanceof SiteAccessError) {
        blocked.add(key)
        outcomes.push({ ...outcome, status: 'ACCESS_RESTRICTED', reason: safeMessage(error.message), diagnostic })
      } else outcomes.push({ ...outcome, status: error instanceof Error && error.message === 'IMPORT_REQUEST_LIMIT' ? 'NOT_EXECUTED' : 'FAILED',
        reason: error instanceof Error ? safeMessage(error.message) : 'Unknown official import failure', diagnostic })
      if (stage === 'ROBOTS' && !(error instanceof SiteAccessError)
        && !(error instanceof Error && error.message === 'IMPORT_REQUEST_LIMIT')) {
        robotsFailures.set(new URL(seed.officialUrl).origin, diagnostic)
      }
    }
  }
  return { requests, limit, outcomes }
}

export function readAuthoritySeeds(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')) }
