import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSiteAccessMetadata, SiteAccessError, SiteAccessManager } from '../src/http/siteAccess.js'
import type { PlannedLegalSearchQuery } from '../src/legalQuery/legalQuerySchema.js'
import { ProviderLegalRetriever } from '../src/retrieval/legalRetriever.js'
import { SupremeCourtSearchProvider } from '../src/retrieval/providers/supremeCourtSearchProvider.js'
import { retrieveWithFallback } from '../src/retrieval/queryFallback.js'
import { fetchSupremeCourtDetail } from '../src/verification/providers/supremeCourtDetailHttp.js'
import { SourceVerificationError } from '../src/verification/sourceVerificationError.js'

const html = '<html><body><div class="search_list"><ul></ul><div class="count">共<span class="num">0</span>篇文章</div></div></body></html>'
const response = (body = html, status = 200, headers: HeadersInit = { 'content-type': 'text/html; charset=utf-8' }) =>
  new Response(body, { status, headers })

test('site access serializes search and detail work for the same origin', async () => {
  const access = new SiteAccessManager({ minIntervalMs: 0 })
  let active = 0, maximum = 0, calls = 0
  const releases: Array<() => void> = []
  const network: typeof fetch = async () => {
    calls++
    active++
    maximum = Math.max(maximum, active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
    return response()
  }
  const search = access.createFetch(network)
  const detail = access.createFetch(network)
  const first = search('https://www.court.gov.cn/search.html?content=a')
  const second = detail('https://www.court.gov.cn/zixun/xiangqing/1.html')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  releases.shift()!()
  await first
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  releases.shift()!()
  await second
  assert.equal(maximum, 1)
})

test('site access applies a configurable interval to different same-origin requests', async () => {
  let now = 10_000
  const waits: number[] = []
  const access = new SiteAccessManager({
    minIntervalMs: 1_000, now: () => now,
    sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds },
  })
  const guarded = access.createFetch(async () => response())
  await guarded('https://www.court.gov.cn/search.html?content=a')
  await guarded('https://www.court.gov.cn/search.html?content=b')
  assert.deepEqual(waits, [1_000])
})

test('403 and 429 open an origin-only circuit and preserve Retry-After without retrying', async () => {
  for (const status of [403, 429]) {
    const access = new SiteAccessManager({ minIntervalMs: 0 })
    let courtCalls = 0, otherCalls = 0
    const court = access.createFetch(async () => {
      courtCalls++
      return response('restricted', status, status === 429 ? { 'retry-after': '120' } : {})
    })
    await assert.rejects(() => court('https://www.court.gov.cn/search.html'), (error: unknown) => {
      assert.ok(error instanceof SiteAccessError)
      assert.equal(error.httpStatus, status)
      assert.equal(error.retryAfter, status === 429 ? '120' : undefined)
      return true
    })
    await assert.rejects(() => court('https://www.court.gov.cn/other.html'), (error: unknown) => error instanceof SiteAccessError)
    assert.equal(courtCalls, 1)
    const other = access.createFetch(async () => { otherCalls++; return response() })
    assert.equal((await other('https://example.test/public')).status, 200)
    assert.equal(otherCalls, 1)
  }
})

test('an explicit CAPTCHA page opens the circuit and is never treated as an empty result', async () => {
  const access = new SiteAccessManager({ minIntervalMs: 0 })
  let calls = 0
  const guarded = access.createFetch(async () => {
    calls++
    return response('<html><head><title>安全验证</title></head><body>请输入验证码</body></html>')
  })
  await assert.rejects(() => guarded('https://www.court.gov.cn/search.html'),
    (error: unknown) => error instanceof SiteAccessError && error.code === 'ACCESS_RESTRICTED')
  await assert.rejects(() => guarded('https://www.court.gov.cn/zixun/xiangqing/1.html'),
    (error: unknown) => error instanceof SiteAccessError)
  assert.equal(calls, 1)
})

test('cache hits avoid network, expose acquisition age, expire, and keep keys isolated', async () => {
  let now = Date.parse('2026-09-17T00:00:00.000Z')
  let calls = 0
  const access = new SiteAccessManager({ minIntervalMs: 0, cacheTtlMs: 1_000, now: () => now })
  const guarded = access.createFetch(async (input) => {
    calls++
    return response(`<html><body>${new URL(String(input)).search}</body></html>`)
  })
  const urlA = 'https://www.court.gov.cn/search.html?content=a'
  const urlB = 'https://www.court.gov.cn/search.html?content=b'
  const first = await guarded(urlA)
  assert.equal(getSiteAccessMetadata(first)?.cacheStatus, 'MISS')
  assert.match(await first.text(), /content=a/)
  now += 500
  const hit = await guarded(urlA)
  assert.equal(getSiteAccessMetadata(hit)?.cacheStatus, 'HIT')
  assert.equal(getSiteAccessMetadata(hit)?.storedAt, '2026-09-17T00:00:00.000Z')
  assert.match(await hit.text(), /content=a/)
  await guarded(urlB)
  assert.equal(calls, 2)
  now += 501
  const expired = await guarded(urlA)
  assert.equal(getSiteAccessMetadata(expired)?.cacheStatus, 'MISS')
  assert.equal(calls, 3)
})

test('abort while queued does not leave the site permanently locked', async () => {
  const access = new SiteAccessManager({ minIntervalMs: 0 })
  let calls = 0
  let release!: () => void
  const guarded = access.createFetch(async () => {
    calls++
    if (calls === 1) await new Promise<void>((resolve) => { release = resolve })
    return response()
  })
  const first = guarded('https://www.court.gov.cn/a')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const controller = new AbortController()
  const cancelled = guarded('https://www.court.gov.cn/b', { signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  const third = guarded('https://www.court.gov.cn/c')
  release()
  await first
  assert.equal((await third).status, 200)
  assert.equal(calls, 2)
})

test('429 is a provider failure and stops query fallback for the restricted site', async () => {
  let calls = 0
  const access = new SiteAccessManager({ minIntervalMs: 0 })
  const provider = new SupremeCourtSearchProvider({ fetch: access.createFetch(async () => {
    calls++
    return response('limited', 429, { 'retry-after': '60' })
  }) })
  const primary = {
    id: 'q1', legalQuestionId: 'question-1', query: '预付款 返还', keywords: ['预付款'],
    legalConcepts: [], searchIntent: 'CONTRACT_RULE' as const,
  }
  const plans: PlannedLegalSearchQuery[] = [{
    ...primary, fallbackQueries: [{ ...primary, id: 'q1-fallback', query: '预付款' }],
  }]
  const result = await retrieveWithFallback(plans, new ProviderLegalRetriever(provider), () => {})
  assert.equal(calls, 1)
  assert.equal(result.retrievalStatus, 'FAILED')
  assert.equal(result.providerFailures[0]?.errorCode, 'ACCESS_RESTRICTED')
  assert.equal(result.queryExecutions[0]?.fallbackTriggered, false)
  assert.deepEqual(result.queryExecutions[0]?.attempts.map((attempt) => attempt.outcome), ['provider-failure'])
})

test('a search restriction prevents a later detail request through the shared manager', async () => {
  const access = new SiteAccessManager({ minIntervalMs: 0 })
  let searchCalls = 0, detailCalls = 0
  const search = new SupremeCourtSearchProvider({ fetch: access.createFetch(async () => {
    searchCalls++
    return response('restricted', 403)
  }) })
  await assert.rejects(() => search.search({
    id: 'q1', legalQuestionId: 'question-1', query: '测试', keywords: [], legalConcepts: [], searchIntent: 'OTHER',
  }, new AbortController().signal))
  await assert.rejects(() => fetchSupremeCourtDetail(
    'https://www.court.gov.cn/zixun/xiangqing/1.html', 'zixun:1', {
      signal: new AbortController().signal,
      fetch: access.createFetch(async () => { detailCalls++; return response() }),
    },
  ), (error: unknown) => error instanceof SourceVerificationError && error.code === 'ACCESS_RESTRICTED')
  assert.equal(searchCalls, 1)
  assert.equal(detailCalls, 0)
})

test('cached official search stays UNVERIFIED and reports HIT instead of fresh access', async () => {
  let calls = 0
  const body = '<html><body><div class="search_list"><ul><li><a href="/zixun/xiangqing/1.html">测试标题</a><span>测试摘要</span></li></ul><div class="count">共<span class="num">1</span>篇文章</div></div></body></html>'
  const access = new SiteAccessManager({ minIntervalMs: 0 })
  const retriever = new ProviderLegalRetriever(new SupremeCourtSearchProvider({ fetch: access.createFetch(async () => {
    calls++
    return response(body)
  }) }))
  const query = { id: 'q1', legalQuestionId: 'question-1', query: '测试', keywords: [], legalConcepts: [], searchIntent: 'OTHER' as const }
  const first = await retriever.retrieve(query)
  const second = await retriever.retrieve({ ...query, id: 'q2' })
  assert.equal(calls, 1)
  assert.equal(first.access?.cacheStatus, 'MISS')
  assert.equal(second.access?.cacheStatus, 'HIT')
  assert.ok(second.sources.every((candidate) => candidate.verificationStatus === 'UNVERIFIED' && candidate.contentTrust === 'UNTRUSTED'))
})
