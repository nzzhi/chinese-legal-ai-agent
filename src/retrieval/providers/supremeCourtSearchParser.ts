import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { RetrievalError } from '../retrievalError.js'
import type { LegalSourceType, ProviderLegalSource } from '../retrievalSchema.js'

export const supremeCourtOrigin = 'https://www.court.gov.cn'
export const supremeCourtLimits = {
  maxResponseBytes: 256_000,
  maxHtmlChars: 128_000,
  maxSourceChars: 2_000,
  maxTitleChars: 500,
  maxResults: 20,
} as const

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((item) => item.name === name)?.value
}
function element(node: Node): node is Element { return 'tagName' in node }
function hasClass(node: Element, name: string): boolean {
  return (attribute(node, 'class') ?? '').split(/\s+/).includes(name)
}
function excluded(node: Element): boolean {
  if (['script', 'style', 'template', 'noscript', 'iframe', 'object', 'svg', 'math', 'head'].includes(node.tagName)) return true
  if (attribute(node, 'hidden') !== undefined || attribute(node, 'aria-hidden')?.toLowerCase() === 'true') return true
  if (['hidden', 'hide', 'd-none', 'sr-only', 'visually-hidden'].some((name) => hasClass(node, name))) return true
  const style = (attribute(node, 'style') ?? '').replace(/\s+|\/\*[\s\S]*?\*\//g, '').toLowerCase()
  return /(?:^|;)(?:display:none|visibility:(?:hidden|collapse)|content-visibility:hidden|opacity:0)(?:!important)?(?:;|$)/.test(style)
}
function* visibleNodes(root: Node): Generator<Node> {
  const stack: { node: Node; depth: number }[] = [{ node: root, depth: 0 }]
  let count = 0
  while (stack.length) {
    const { node, depth } = stack.pop()!
    if (++count > 20_000 || depth > 128) invalid('HTML tree exceeds parsing limits')
    if (element(node) && excluded(node)) continue
    yield node
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i], depth: depth + 1 })
    }
  }
}
function findAll(root: Node, predicate: (node: Element) => boolean): Element[] {
  return [...visibleNodes(root)].filter((node): node is Element => element(node) && predicate(node))
}
function text(root: Node): string {
  const parts: string[] = []
  for (const node of visibleNodes(root)) {
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value)
    if (element(node) && ['br', 'p', 'div', 'li'].includes(node.tagName)) parts.push(' ')
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}
function invalid(message: string): never { throw new RetrievalError('INVALID_RESPONSE', message) }

/** The search page supplies no legal category field. Do not infer type from title,
 * the /zixun/ route, quoted law names, or an article about a judicial interpretation.
 */
export function mapSupremeCourtSearchType(): LegalSourceType { return 'OTHER_LEGAL_MATERIAL' }

export function parseSupremeCourtSearch(html: string, searchUrl: string, debug?: (data: Record<string, unknown>) => void): {
  complete: boolean; sources: ProviderLegalSource[]
} {
  if (html.length > supremeCourtLimits.maxHtmlChars) invalid('Official search HTML exceeds character limit')
  let request: URL
  try { request = new URL(searchUrl) } catch { invalid('Malformed official search URL') }
  if (request.origin !== supremeCourtOrigin || request.pathname !== '/search.html' || request.username || request.password) {
    invalid('Unexpected official search URL')
  }
  // Explicit closing document boundary detects common truncated HTML responses.
  if (!/<\/html\s*>/i.test(html.trim())) invalid('Official search document is incomplete')
  const document = parse(html)
  const roots = findAll(document, (node) => hasClass(node, 'search_list'))
  if (roots.length !== 1) invalid('Official search result container missing or ambiguous')
  const root = roots[0]
  const counts = findAll(root, (node) => hasClass(node, 'count'))
  if (counts.length !== 1) invalid('Official result count missing')
  const countNodes = findAll(counts[0], (node) => hasClass(node, 'num'))
  if (countNodes.length !== 1 || !/^\d+$/.test(text(countNodes[0]))) invalid('Official result count malformed')
  const total = Number(text(countNodes[0]))
  if (!Number.isSafeInteger(total)) invalid('Official result count out of range')
  const lists = root.childNodes.filter((node): node is Element => element(node) && node.tagName === 'ul' && !excluded(node))
  if (lists.length !== 1) invalid('Official result list missing or ambiguous')
  const items = lists[0].childNodes.filter((node): node is Element => element(node) && node.tagName === 'li' && !excluded(node))
  const rawItems = lists[0].childNodes.filter((node) => element(node) && node.tagName === 'li')
  debug?.({ phase: 'parse-input', reportedTotal: total, beforeParsing: rawItems.length, visibleItems: items.length,
    filteredCount: rawItems.length - items.length, filterReason: 'Only explicitly hidden list items excluded; malformed visible records throw' })
  if (total < items.length) invalid('Official result count contradicts returned records')
  // A full HTML page may expose only part of the reported results (e.g. pagination).
  let complete = total === items.length && items.length <= supremeCourtLimits.maxResults
  const sources: ProviderLegalSource[] = []
  // Validate even overflow rows: no silent malformed-source filtering.
  for (const item of items) {
    const anchors = findAll(item, (node) => node.tagName === 'a')
    const snippets = item.childNodes.filter((node): node is Element => element(node) && node.tagName === 'span' && !excluded(node))
    if (anchors.length !== 1 || snippets.length !== 1) invalid('Official result title/link/snippet missing or ambiguous')
    const title = text(anchors[0])
    const fullContent = text(snippets[0])
    if (!title || title.length > supremeCourtLimits.maxTitleChars || !fullContent) invalid('Official result text missing or oversized')
    const href = attribute(anchors[0], 'href')
    if (!href || href !== href.trim()) invalid('Official result URL missing or malformed')
    let url: URL
    try { url = new URL(href, supremeCourtOrigin) } catch { invalid('Official result URL malformed') }
    const match = url.pathname.match(/^\/([a-z]+)\/xiangqing\/(\d+)\.html$/)
    if (url.origin !== supremeCourtOrigin || url.username || url.password || url.search || url.hash || !match) {
      invalid('Official result URL outside supported detail routes')
    }
    const truncated = fullContent.length > supremeCourtLimits.maxSourceChars
    if (truncated) complete = false
    // Avoid splitting a UTF-16 surrogate pair at the limit.
    let content = fullContent.slice(0, supremeCourtLimits.maxSourceChars)
    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1)
    sources.push({
      providerSourceId: `${match[1]}:${match[2]}`,
      sourceType: mapSupremeCourtSearchType(),
      title,
      content,
      sourceUrl: url.href,
      sourceOrigin: supremeCourtOrigin,
      locator: `SEARCH_SNIPPET; originalChars=${fullContent.length}; retainedChars=${content.length}; truncated=${truncated}`,
    })
  }
  const retained = sources.slice(0, supremeCourtLimits.maxResults)
  debug?.({ phase: 'parse-output', afterParsing: sources.length, afterFiltering: retained.length,
    filteredCount: sources.length - retained.length, filterReason: sources.length > retained.length ? 'maxResults overflow; partial results retained with complete=false' : 'none', complete })
  return { complete, sources: retained }
}

