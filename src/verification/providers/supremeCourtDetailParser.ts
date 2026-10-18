import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { VerificationEvidence } from '../sourceVerificationSchema.js'
import { SourceVerificationError } from '../sourceVerificationError.js'

export const supremeCourtDetailLimits = {
  maxResponseBytes: 256_000,
  maxHtmlChars: 128_000,
  maxContentChars: 50_000,
  minContentChars: 80,
  maxTitleChars: 500,
  maxDomDepth: 128,
} as const
export const supremeCourtDetailParserId = 'supreme-court-detail-v2'

export interface ParsedSupremeCourtDetail {
  title: string
  content: string
  publicationDate?: string
  publicationDateStatus: 'VERIFIED' | 'UNKNOWN' | 'MISMATCH'
  publicationDateReason: string
  publicationDateRaw: string[]
  canonicalUrls: string[]
  completeness: 'VERIFIED' | 'UNKNOWN'
  completenessReason: string
}

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

function invalid(message: string): never {
  throw new SourceVerificationError('INVALID_RESPONSE', message)
}
function element(node: Node): node is Element { return 'tagName' in node }
function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((item) => item.name === name)?.value
}
function hasClass(node: Element, name: string): boolean {
  return (attribute(node, 'class') ?? '').split(/\s+/).includes(name)
}
function excluded(node: Element): boolean {
  if (['script', 'style', 'template', 'noscript', 'iframe', 'object', 'svg', 'math'].includes(node.tagName)) return true
  if (attribute(node, 'hidden') !== undefined || attribute(node, 'aria-hidden')?.toLowerCase() === 'true') return true
  if (['hidden', 'hide', 'd-none', 'sr-only', 'visually-hidden'].some((name) => hasClass(node, name))) return true
  const style = (attribute(node, 'style') ?? '').replace(/\s+|\/\*[\s\S]*?\*\//g, '').toLowerCase()
  return /(?:^|;)(?:display:none|visibility:(?:hidden|collapse)|content-visibility:hidden|opacity:0)(?:!important)?(?:;|$)/.test(style)
}
function chrome(node: Element): boolean {
  return ['nav', 'footer', 'aside', 'form', 'button'].includes(node.tagName) ||
    ['nav', 'footer', 'sidebar', 'share', 'handle', 'txt_etr', 'related', 'related-news', 'recommend'].some((name) => hasClass(node, name))
}

/** Bound every node, including hidden/template content, before selecting visible article data. */
function checkTree(root: Node): void {
  const stack: { node: Node; depth: number }[] = [{ node: root, depth: 0 }]
  let count = 0
  while (stack.length) {
    const { node, depth } = stack.pop()!
    if (++count > 30_000 || depth > supremeCourtDetailLimits.maxDomDepth) invalid('Official detail HTML tree exceeds parsing limits')
    if ('childNodes' in node) {
      for (const child of node.childNodes) stack.push({ node: child, depth: depth + 1 })
    }
    if ('content' in node && node.content && typeof node.content === 'object' && 'nodeName' in node.content) {
      stack.push({ node: node.content as Node, depth: depth + 1 })
    }
  }
}
function* visibleNodes(root: Node): Generator<Node> {
  const stack: Node[] = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (element(node) && excluded(node)) continue
    yield node
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i])
    }
  }
}
function findAll(root: Node, predicate: (node: Element) => boolean): Element[] {
  return [...visibleNodes(root)].filter((node): node is Element => element(node) && predicate(node))
}

/** Text is data, including visible instructions. Preserve paragraph boundaries without executing HTML. */
function text(root: Node, ignored: ReadonlySet<Node> = new Set(), omitAnchors = false): string {
  const parts: string[] = []
  const stack: { node: Node; closing: boolean }[] = [{ node: root, closing: false }]
  const blocks = new Set(['p', 'div', 'li', 'ul', 'ol', 'section', 'article', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'tr'])
  while (stack.length) {
    const { node, closing } = stack.pop()!
    if (ignored.has(node)) continue
    if (element(node) && (excluded(node) || chrome(node) || (omitAnchors && node.tagName === 'a'))) continue
    if (closing) { parts.push('\n'); continue }
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value.replace(/\s+/g, ' '))
    if (element(node)) {
      if (node.tagName === 'br') parts.push('\n')
      if (blocks.has(node.tagName)) {
        parts.push('\n')
        stack.push({ node, closing: true })
      }
      if (['td', 'th'].includes(node.tagName)) parts.push(' ')
    }
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i], closing: false })
    }
  }
  return parts.join('').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}
function inlineText(root: Node): string { return text(root).replace(/\s+/g, ' ').trim() }
function controlText(root: Node): string {
  return [...visibleNodes(root)].filter((node) => node.nodeName === '#text' && 'value' in node)
    .map((node) => 'value' in node ? node.value : '').join('').replace(/\s+/g, ' ').trim()
}

function requireClosed(node: Element, label: string): void {
  if (!node.sourceCodeLocation?.startTag || !node.sourceCodeLocation.endTag) invalid('Official detail ' + label + ' is not explicitly closed')
}

/** Only remove a final, standalone news-links heading followed solely by link blocks. */
function recommendationTail(article: Element): Set<Node> {
  const children = article.childNodes.filter((node) =>
    !(element(node) && excluded(node)) && inlineText(node).length > 0)
  const ignored = new Set<Node>()
  for (let index = 0; index < children.length - 1; index++) {
    const heading = children[index]
    if (!element(heading) || heading.tagName !== 'p' || !/^新闻链接[：:]$/.test(inlineText(heading))) continue
    const tail = children.slice(index + 1)
    if (tail.every((node) => element(node) && ['p', 'div', 'ul'].includes(node.tagName) &&
      findAll(node, (item) => item.tagName === 'a').length > 0 && text(node, new Set(), true).length === 0)) {
      ignored.add(heading)
      tail.forEach((node) => ignored.add(node))
      break
    }
  }
  return ignored
}

function readPublicationDate(detail: Element, observedAt: string): Pick<ParsedSupremeCourtDetail,
  'publicationDate' | 'publicationDateStatus' | 'publicationDateReason' | 'publicationDateRaw'> {
  const publicationDateRaw = findAll(detail, (node) => hasClass(node, 'detail_mes'))
    .flatMap((metadata) => findAll(metadata, (node) => hasClass(node, 'message')))
    .flatMap((message) => findAll(message, (node) => node.tagName === 'li'))
    .map(inlineText).filter((value) => /^发布时间/.test(value))
  if (!publicationDateRaw.length) return { publicationDateRaw, publicationDateStatus: 'UNKNOWN', publicationDateReason: 'Official publication field is absent' }
  if (publicationDateRaw.length !== 1) return { publicationDateRaw, publicationDateStatus: 'MISMATCH', publicationDateReason: 'Official publication field is ambiguous' }
  const match = publicationDateRaw[0].match(/^发布时间\s*[：:]\s*(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!match) return { publicationDateRaw, publicationDateStatus: 'MISMATCH', publicationDateReason: 'Official publication field is malformed' }
  const date = match[1] + '-' + match[2] + '-' + match[3]
  const parsedDate = new Date(date + 'T00:00:00.000Z')
  const validDay = Number(match[1]) > 0 && Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date
  const validTime = match[4] === undefined || (Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6] ?? 0) <= 59)
  const observedDay = new Date(new Date(observedAt).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (!validDay || !validTime || date > observedDay) {
    return { publicationDateRaw, publicationDateStatus: 'MISMATCH', publicationDateReason: 'Official publication date is invalid or later than the observed China date' }
  }
  return { publicationDateRaw, publicationDate: date, publicationDateStatus: 'VERIFIED', publicationDateReason: 'One explicit official publication field contains a valid non-future date; time-of-day is not verified' }
}

/** Parse one observed source snapshot. This verifies neither legal category nor legal effect.
 * FULL_DETAIL_PAGE refers only to the selected HTML article, not linked attachments or laws.
 */
export function parseSupremeCourtDetail(html: string, observedAt: string): ParsedSupremeCourtDetail {
  if (typeof html !== 'string' || html.length > supremeCourtDetailLimits.maxHtmlChars) invalid('Official detail HTML exceeds character limit or is not text')
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
    throw new SourceVerificationError('INVALID_INPUT', 'Detail observation timestamp is invalid')
  }
  const document = parse(html, { sourceCodeLocationInfo: true })
  checkTree(document)
  const htmlNodes = findAll(document, (node) => node.tagName === 'html')
  const bodyNodes = findAll(document, (node) => node.tagName === 'body')
  if (htmlNodes.length !== 1 || bodyNodes.length !== 1) invalid('Official detail document is missing')
  requireClosed(htmlNodes[0], 'document')
  requireClosed(bodyNodes[0], 'body')
  const diagnostics: NonNullable<VerificationEvidence['parserDiagnostics']> = {
    htmlTitle: findAll(document, (node) => node.tagName === 'title').map(inlineText).join(' | ').slice(0, 500),
    pageType: 'UNKNOWN', articleCandidateCount: 0, step: 'container',
  }
  if (findAll(document, (node) => node.tagName === 'form' && (attribute(node, 'action') ?? '').includes('search')).length) diagnostics.pageType = 'SEARCH'
  const invalidDetail = (message: string): never => {
    const error = new SourceVerificationError('INVALID_RESPONSE', message)
    error.evidence = { redirects: [], parserDiagnostics: { ...diagnostics } }
    throw error
  }
  const details = findAll(bodyNodes[0], (node) => hasClass(node, 'detail'))
  if (details.length !== 1) invalidDetail('Official detail container missing or ambiguous')
  diagnostics.pageType = 'DETAIL_STRUCTURE'
  diagnostics.step = 'title'
  const detail = details[0]
  requireClosed(detail, 'container')
  const titles = detail.childNodes.filter((node): node is Element => element(node) && !excluded(node) && hasClass(node, 'title'))
  if (titles.length !== 1) invalidDetail('Official detail title missing or ambiguous')
  requireClosed(titles[0], 'title')
  const title = inlineText(titles[0])
  if (!title || title.length > supremeCourtDetailLimits.maxTitleChars) invalid('Official detail title empty or oversized')
  const articles = findAll(detail, (node) => hasClass(node, 'txt_txt'))
  diagnostics.step = 'article-selection'
  diagnostics.articleCandidateCount = articles.length
  if (articles.length !== 1) invalidDetail('Official detail article missing or ambiguous')
  const article = articles[0]
  const publication = readPublicationDate(detail, observedAt)
  // Observed 2017 jianshe template: .detail > .txt.big > div.txt_txt without an id.
  // A missing zoom ID alone is insufficient: require the exact wrapper and dated metadata.
  const parent = article.parentNode
  const legacyTemplate = article.tagName === 'div' && attribute(article, 'id') === undefined
    && parent && element(parent) && parent.tagName === 'div' && hasClass(parent, 'txt') && hasClass(parent, 'big')
    && parent.parentNode === detail && publication.publicationDateStatus === 'VERIFIED'
    && findAll(detail, (node) => hasClass(node, 'detail_mes')).length === 1
  if (attribute(article, 'id') !== 'zoom' && !legacyTemplate) invalidDetail('Official detail article template is unsupported')
  requireClosed(article, 'article')
  // HTML recovery must not let a later template closing tag stand in for an unfinished article.
  if (article.sourceCodeLocation!.endTag!.endOffset > detail.sourceCodeLocation!.endTag!.startOffset ||
      detail.sourceCodeLocation!.endTag!.endOffset > bodyNodes[0].sourceCodeLocation!.endTag!.startOffset) {
    invalid('Official detail article boundaries conflict with its container')
  }
  const content = text(article, recommendationTail(article))
  if (!content || content.length > supremeCourtDetailLimits.maxContentChars) invalid('Official detail content empty or oversized')
  const incompleteNodes = findAll(detail, (node) =>
    ['pagination', 'pages', 'pagenav', 'pagebar', 'page', 'truncated'].some((name) => hasClass(node, name)) ||
    attribute(node, 'data-truncated') === 'true' || attribute(node, 'data-complete') === 'false' ||
    (node.tagName === 'a' && (attribute(node, 'rel') ?? '').toLowerCase().split(/\s+/).includes('next')) ||
    (['a', 'button'].includes(node.tagName) && /^(?:下一页|下页|阅读全文|加载更多|继续阅读|next\s*page)$/i.test(controlText(node))))
  // Canonical metadata is not visible body text: never discard a declaration because it is hidden.
  const canonicalUrls = htmlNodes[0].childNodes.filter((node): node is Element => element(node) && node.tagName === 'head')
    .flatMap((head) => head.childNodes.filter((node): node is Element => element(node) && node.tagName === 'link' &&
      (attribute(node, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')))
    .map((node) => attribute(node, 'href') ?? '')
  return {
    title, content, ...publication, canonicalUrls,
    completeness: incompleteNodes.length ? 'UNKNOWN' : 'VERIFIED',
    completenessReason: incompleteNodes.length
      ? 'Page contains explicit pagination or truncation controls; no subsequent page was fetched'
      : 'Explicit article/document boundaries and bounded extraction completed without local truncation; linked resources are outside this snapshot',
  }
}

