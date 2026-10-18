import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { isExplicitAccessRestrictionPage } from '../http/siteAccess.js'

export const officialAuthorityParsers = ['TAX', 'CICC', 'SUPREME_COURT', 'FUJIAN'] as const
export type OfficialAuthorityParser = typeof officialAuthorityParsers[number]
/** The single host <-> parser mapping: the importer admits a snapshot with it and the verifier re-reads with it. */
export const officialAuthorityParserHosts: Record<OfficialAuthorityParser, string> = {
  TAX: 'fgk.chinatax.gov.cn', CICC: 'cicc.court.gov.cn', SUPREME_COURT: 'www.court.gov.cn', FUJIAN: 'zrzyt.fujian.gov.cn' }
export const parserForOfficialHost = (hostname: string): OfficialAuthorityParser | undefined =>
  officialAuthorityParsers.find(name => officialAuthorityParserHosts[name] === hostname)
type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const maxBytes = 2 * 1024 * 1024

function element(node: Node): node is Element { return 'tagName' in node }
function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find(item => item.name === name)?.value
}
function hasClass(node: Element, name: string): boolean {
  return (attribute(node, 'class') ?? '').split(/\s+/).includes(name)
}
function hidden(node: Element): boolean {
  return ['script', 'style', 'template', 'noscript', 'iframe', 'nav', 'footer', 'aside'].includes(node.tagName)
    || ['related', 'related-news', 'recommend', 'share', 'pagination'].some(name => hasClass(node, name))
    || attribute(node, 'hidden') !== undefined || attribute(node, 'aria-hidden') === 'true'
    || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attribute(node, 'style') ?? '')
}
function nodes(root: Node): Node[] {
  const output: Node[] = []
  const stack = [{ node: root, depth: 0 }]
  while (stack.length) {
    const { node, depth } = stack.pop()!
    if (output.length >= 100_000 || depth > 128) throw new Error('Authority HTML exceeds DOM limits')
    if (element(node) && hidden(node)) continue
    output.push(node)
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        stack.push({ node: node.childNodes[index]!, depth: depth + 1 })
      }
    }
  }
  return output
}
function text(root: Node): string {
  const parts: string[] = []
  for (const node of nodes(root)) {
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value.replace(/\s+/gu, ' '))
    if (element(node) && ['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'tr'].includes(node.tagName)) parts.push('\n')
  }
  return parts.join('').split('\n').map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n')
}

/** Explicit selectors from inspected official pages; no guessed API or article-ID discovery. */
export function parseOfficialAuthorityHtml(html: string, parser: OfficialAuthorityParser, expectedTitle: string) {
  if (Buffer.byteLength(html, 'utf8') > maxBytes) throw new Error('Authority HTML exceeds 2MB')
  if (isExplicitAccessRestrictionPage(html, 'text/html')) throw new Error('Authority page is access restricted')
  const document = parse(html, { sourceCodeLocationInfo: true })
  const all = nodes(document)
  const candidates = all.filter((node): node is Element => element(node) && (
    parser === 'TAX' ? node.tagName === 'div' && hasClass(node, 'arc_cont')
      : parser === 'CICC' ? node.tagName === 'article' && hasClass(node, 'essay-content')
        : parser === 'FUJIAN' ? node.tagName === 'div' && hasClass(node, 'TRS_Editor')
        : node.tagName === 'div' && hasClass(node, 'txt_txt') && attribute(node, 'id') === 'zoom'
  ))
  if (candidates.length !== 1) throw new Error('Official authority body is missing or ambiguous')
  let body = candidates[0]!
  if (parser === 'CICC') {
    const contained = nodes(body).filter((node): node is Element => element(node) && node.tagName === 'div'
      && attribute(node, 'align') === 'center' && /position\s*:\s*relative/i.test(attribute(node, 'style') ?? ''))
    if (contained.length !== 1) throw new Error('CICC authority article body is missing or ambiguous')
    body = contained[0]!
  }
  if (!body.sourceCodeLocation?.endTag) throw new Error('Official authority body is not explicitly closed')
  const pageText = text(document)
  const content = text(body)
  const firstArticle = /^第[一二三四五六七八九十百千万零〇两\d]+条/mu.exec(content)
  if (!firstArticle) {
    throw new Error('Official authority body contains no numbered articles')
  }
  let metadataText = content.slice(0, firstArticle.index)
  let metadataTitle: string | undefined
  let wrapper: Node | undefined = parser === 'CICC' ? candidates[0] : undefined
  if (parser === 'FUJIAN') {
    // Inspected provincial official republication: one desktop metadata table and one legal text container.
    const tables = all.filter((node): node is Element => element(node) && node.tagName === 'table'
      && hasClass(node, 'tp-table') && hasClass(node, 'tp-pc'))
    if (tables.length !== 1) throw new Error('Official metadata table is missing or ambiguous')
    const cells = nodes(tables[0]).filter((node): node is Element => element(node) && node.tagName === 'td').map(text)
    const fields = new Map<string, string>()
    for (let i = 0; i < cells.length; i += 2) {
      if (cells[i] && cells[i + 1]) fields.set(cells[i], cells[i + 1])
    }
    metadataTitle = fields.get('名称')
    if (metadataTitle !== expectedTitle || !metadataText.split('\n').includes(expectedTitle)) {
      throw new Error('Official metadata and body titles do not both match this document')
    }
    // Preserve source words exactly: a table cell boundary is whitespace, not invented punctuation.
    metadataText = [...fields].map(([label, value]) => `${label}\n${value}`).join('\n') + '\n' + metadataText
  } else if (parser === 'TAX') {
    // Inspected tax pages keep status/date/title and arc_cont in their nearest div.article.
    let parent: Node | undefined = body.parentNode ?? undefined
    while (parent && !(element(parent) && parent.tagName === 'div' && hasClass(parent, 'article'))) {
      parent = 'parentNode' in parent ? parent.parentNode ?? undefined : undefined
    }
    if (parent) {
      wrapper = parent
      const wrapperText = text(parent)
      const offset = wrapperText.indexOf(content)
      metadataText = offset >= 0 ? wrapperText.slice(0, offset) + metadataText : ''
    } else metadataText = ''
  } else if (parser === 'SUPREME_COURT') {
    let parent: Node | undefined = body.parentNode ?? undefined
    while (parent && !(element(parent) && hasClass(parent, 'detail'))) {
      parent = 'parentNode' in parent ? parent.parentNode ?? undefined : undefined
    }
    wrapper = parent
  }
  const bodyNodes = new Set(nodes(body))
  const titleNodes = wrapper ? nodes(wrapper).filter((node): node is Element => element(node)
    && !bodyNodes.has(node) && (['h1', 'h2', 'h3'].includes(node.tagName) || hasClass(node, 'title'))) : []
  const normalizeTitle = (title: string) => title.replace(/\s+/gu, '')
    .replace(/[（(]\d{4}年[^）)]*修正[）)]$/u, '')
  const titleKey = normalizeTitle(expectedTitle)
  const headerTitles = metadataTitle ? [metadataTitle] : titleNodes.map(text)
  const bodyTitles = metadataText.split('\n').map(line => line.replace(/^[〖【](?:法规名称|法规标题|标题)[〗】]\s*/u, ''))
  const actualTitle = (headerTitles.length ? headerTitles : bodyTitles).find(title => normalizeTitle(title) === titleKey)
  if (!titleKey || !actualTitle) throw new Error('Official authority main title does not match manifest')
  return { title: actualTitle, content, pageText, metadataText }
}
