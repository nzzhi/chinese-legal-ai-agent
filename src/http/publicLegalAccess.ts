import { robotsAllows, readOfficialResponse } from '../authority/authorityImporter.js'
import { SiteAccessError } from './siteAccess.js'

/** Shared per-run robots decisions, including failures: never try another URL to evade a restriction. */
export function publicLegalAccess() {
  const policies = new Map<string, Promise<string>>()
  const blocked = new Set<string>()
  return (delegate: typeof fetch): typeof fetch => async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    const key = url.hostname.endsWith('.court.gov.cn') ? 'court.gov.cn' : url.hostname
    if (blocked.has(key)) throw new SiteAccessError('ACCESS_RESTRICTED', '本次研究已停止访问受限站点', url.origin)
    if (!policies.has(url.origin)) policies.set(url.origin, (async () => {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)])
      const response = await delegate(new URL('/robots.txt', url), { redirect:'error', signal })
      if (response.status === 404) { void response.body?.cancel().catch(() => {}); return '' }
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new Error(`Robots unavailable: HTTP ${response.status}`) }
      return readOfficialResponse(response, signal)
    })())
    try {
      if (!robotsAllows(await policies.get(url.origin)!, url.href)) throw new SiteAccessError('ACCESS_RESTRICTED', 'robots.txt 不允许访问此地址', url.origin)
      return await delegate(request, init)
    } catch (error) {
      blocked.add(key)
      throw error
    }
  }
}
