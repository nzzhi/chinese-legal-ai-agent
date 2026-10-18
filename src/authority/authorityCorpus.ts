import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { z } from 'zod'
import { authorityExpansion, authorityConceptMatch, rankAuthorityArticle, retrievalTaskMatch } from './authorityConcepts.js'
import {
  authorityArticleSchema, authorityDocumentSchema, authorityHash, authorityImportSchema,
  authoritySearchSchema, authoritySourceConfigSchema,
  type AuthorityArticle, type AuthorityDocument, type AuthorityImport, type AuthoritySearchHit,
  type AuthoritySearchInput, type AuthoritySourceConfig,
} from './authoritySchema.js'

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
// Grammatical query words convey no legal subject or disputed action.
const stopWords = new Set(['什么', '如何', '是否', '哪些', '法律', '规定', '需要', '可以', '以及',
  '根据', '关于', '问题', '依据', '影响', '相关', '当时', '现在', '没有', '存在', '进行', '要求',
  '应当', '如果', '认为', '同时'])
const words = (text: string) => [...new Set([...segmenter.segment(text.normalize('NFKC').toLowerCase())]
  .filter(part => part.isWordLike && part.segment.length >= 2 && !stopWords.has(part.segment))
  .map(part => part.segment))].slice(0, 64)
const grams = (text: string) => (text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]{2,}/gu) ?? [])
  .flatMap(run => [...run].slice(0, 2000).slice(0, -1).map((_, i) => run.slice(i, i + 2)))
const indexText = (text: string) => [...new Set([...words(text), ...grams(text)])].join(' ')
const compact = (text: string) => text.replace(/\s+/gu, '')

/** Adjacent grammatical fragments from one word must not count as separate relevance anchors. */
function matchedAnchors(input: string, articleText: string): string[] {
  const normalized = input.normalize('NFKC').toLowerCase()
  const matches = [...new Set([...words(input), ...grams(input)])]
    .filter(token => !stopWords.has(token) && articleText.includes(token))
    .map(token => ({ token, start: normalized.indexOf(token) }))
    .sort((a, b) => a.start - b.start || b.token.length - a.token.length)
  const selected: typeof matches = []
  for (const match of matches) {
    if (!selected.some(item => match.start < item.start + item.token.length && item.start < match.start + match.token.length)) selected.push(match)
  }
  return selected.map(item => item.token)
}

export function formulateAuthorityFts(query: string, legalQuestion?: string) {
  const request = authoritySearchSchema.parse({ query, legalQuestion })
  const queryWords = words(request.query)
  const questionWords = words(request.legalQuestion ?? request.query)
  const expansion = authorityExpansion(request.query, request.legalQuestion).join(' ')
  const tokens = [...new Set([...words(expansion), ...grams(expansion), ...queryWords, ...questionWords, ...grams(request.query)])].slice(0, 96)
  const providerQuery = tokens.map(token => '"' + token.replaceAll('"', '""') + '"').join(' OR ')
  return { queryWords, questionWords, tokens, providerQuery }
}

/** A deterministic lexical gate; never an inference of case applicability. */
export function authorityArticleRelevance(articleText: string, query: string, legalQuestion?: string,
  taskQuery?: string): AuthoritySearchHit['match'] {
  const article = z.string().min(1).max(4_000_000).parse(articleText)
  const { queryWords, questionWords, tokens, providerQuery } = formulateAuthorityFts(query, legalQuestion)
  const text = article.normalize('NFKC').toLowerCase()
  const matchedTokens = tokens.filter(token => text.includes(token))
  const queryMatches = queryWords.filter(token => text.includes(token))
  const questionMatches = questionWords.filter(token => text.includes(token))
  const queryCoverage = queryMatches.length / Math.max(1, queryWords.length)
  const questionCoverage = questionMatches.length / Math.max(1, questionWords.length)
  const anchors = [...new Set([...matchedAnchors(query, text), ...matchedAnchors(legalQuestion ?? query, text)])]
  const relevanceAnchors = anchors.filter(token => !anchors.some(other => other !== token && other.includes(token)))
  const concept = authorityConceptMatch(article, query, legalQuestion)
  // Recheck the same owning primary task that selected this candidate, rather than
  // letting incidental fact words dilute its lexical coverage. Legacy calls stay lexical.
  const taskSufficient = taskQuery !== undefined && retrievalTaskMatch(article, taskQuery, legalQuestion).sufficient
  const relevanceSufficient = concept.sufficient || taskSufficient
    || relevanceAnchors.length >= 2 && queryCoverage >= 0.2 && questionCoverage >= 0.1
  return { providerQuery, tokens, matchedTokens, relevanceAnchors: [...new Set([...relevanceAnchors, ...concept.matchedConcepts])],
    queryCoverage, questionCoverage, relevanceSufficient }
}

/** HTML extraction is only used to check that controlled body text is in the raw snapshot. */
export function authoritySnapshotText(content: string, format: 'HTML' | 'TEXT'): string {
  if (format === 'TEXT') return content
  const stack: { node: DefaultTreeAdapterMap['node']; depth: number }[] = [{ node: parse(content), depth: 0 }]
  const parts: string[] = []
  let count = 0
  while (stack.length) {
    const { node, depth } = stack.pop()!
    if (++count > 150_000 || depth > 256) throw new Error('Official snapshot exceeds DOM parsing limits')
    if ('tagName' in node) {
      const attribute = (name: string) => node.attrs.find(item => item.name === name)?.value
      if (['script', 'style', 'noscript', 'template', 'iframe', 'object', 'svg', 'math'].includes(node.tagName)
        || attribute('hidden') !== undefined || attribute('aria-hidden') === 'true'
        || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attribute('style') ?? '')) continue
    }
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value)
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i], depth: depth + 1 })
    }
  }
  return parts.join(' ')
}

export function splitAuthorityArticles(documentId: string, bodyText: string): AuthorityArticle[] {
  const matches = [...bodyText.matchAll(/^[\t \u3000]*(第[零〇一二三四五六七八九十百千万\d]+条)/gm)]
  if (matches.length === 0) throw new Error('Official body contains no line-delimited legal articles')
  const headings = [...bodyText.matchAll(/^[\t \u3000]*((?:第[零〇一二三四五六七八九十百千万\d]+[编章节][^\n。；]{0,100}|[一二三四五六七八九十百千万]+、[^\n。；：]{1,40}))[\t \u3000]*$/gm)]
  const seen = new Set<string>()
  return matches.map((match, i) => {
    const articleNumber = match[1]
    if (seen.has(articleNumber)) throw new Error(`Duplicate article number: ${articleNumber}`)
    seen.add(articleNumber)
    const start = match.index! + match[0].indexOf(articleNumber)
    let end = matches[i + 1]?.index ?? bodyText.length
    const followingHeading = headings.find(heading => heading.index! > start && heading.index! < end)
    if (followingHeading) end = followingHeading.index!
    while (end > start && /\s/u.test(bodyText[end - 1])) end--
    const text = bodyText.slice(start, end)
    const heading = headings.filter(item => item.index! < start).at(-1)?.[1].trim() ?? ''
    return authorityArticleSchema.parse({
      id: `article-${authorityHash(documentId + '\n' + articleNumber + '\n' + text).slice(0, 40)}`,
      documentId, articleNumber, heading, text, textHash: authorityHash(text), start, end,
    })
  })
}

/** A hit plus the ranking diagnostics the search entry point keeps; the production `search` drops them. */
type RankedAuthorityHit = AuthoritySearchHit & { rawRank: number; ftsScore: number; finalRank: number;
  rankingSignals: ReturnType<typeof rankAuthorityArticle> }

export class AuthorityCorpus {
  private readonly db: DatabaseSync
  private readonly sources: AuthoritySourceConfig[]
  private readonly snapshots: string
  private readonly readOnly: boolean

  constructor(dbPath: string, options: { sources?: AuthoritySourceConfig[]; readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly ?? false
    const config = options.sources ?? JSON.parse(readFileSync(new URL('../../config/authority-sources.json', import.meta.url), 'utf8'))
    this.sources = z.array(authoritySourceConfigSchema).min(1).parse(config)
    if (new Set(this.sources.map(source => source.id)).size !== this.sources.length) throw new Error('Duplicate authority source ID')
    if (dbPath === ':memory:') throw new Error('Authority snapshots require a persistent database path')
    const absolute = resolve(dbPath)
    if (!options.readOnly) mkdirSync(dirname(absolute), { recursive: true })
    this.snapshots = resolve(dirname(absolute), 'snapshots')
    if (!options.readOnly) mkdirSync(this.snapshots, { recursive: true })
    this.db = new DatabaseSync(absolute, { readOnly: options.readOnly ?? false })
    if (options.readOnly) return
    this.db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS document (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, documentType TEXT NOT NULL, issuingAuthority TEXT NOT NULL,
        promulgatedAt TEXT, effectiveAt TEXT, validityStatus TEXT NOT NULL, officialUrl TEXT NOT NULL,
        contentHash TEXT NOT NULL, fetchedAt TEXT NOT NULL, sourceId TEXT NOT NULL, validityEvidence TEXT,
        bodyText TEXT NOT NULL, snapshotHash TEXT NOT NULL, snapshotPath TEXT NOT NULL, snapshotFormat TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS article (
        id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES document(id), articleNumber TEXT NOT NULL,
        heading TEXT NOT NULL, text TEXT NOT NULL, textHash TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
        UNIQUE(documentId, articleNumber)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(articleId UNINDEXED, terms, tokenize='unicode61');`)
  }

  /** No network or model: import an explicitly obtained official snapshot and its exact extracted body. */
  importDocument(input: AuthorityImport): { document: AuthorityDocument; articles: AuthorityArticle[] } {
    if (this.readOnly) throw new Error('Read-only authority corpus')
    const imported = authorityImportSchema.parse(input)
    this.validateSource(imported.document)
    const extracted = compact(authoritySnapshotText(imported.snapshot.content, imported.snapshot.format))
    if (!extracted.includes(compact(imported.bodyText))) throw new Error('Body text does not belong to official snapshot')
    const evidence = imported.document.validityEvidence
    if (evidence && !extracted.includes(compact(evidence.excerpt))) throw new Error('Validity excerpt is absent from official snapshot')
    if (!extracted.includes(compact(imported.document.title))) throw new Error('Document title is absent from official snapshot')
    const { snapshotHash, snapshotPath } = this.saveSnapshot(imported.snapshot.content, imported.snapshot.format)
    const document = authorityDocumentSchema.parse({
      ...imported.document, contentHash: authorityHash(imported.bodyText), bodyText: imported.bodyText,
      snapshotHash, snapshotPath, snapshotFormat: imported.snapshot.format,
    })
    const articles = splitAuthorityArticles(document.id, document.bodyText)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM article_fts WHERE articleId IN (SELECT id FROM article WHERE documentId = ?)').run(document.id)
      this.db.prepare('DELETE FROM article WHERE documentId = ?').run(document.id)
      this.db.prepare('DELETE FROM document WHERE id = ?').run(document.id)
      this.db.prepare(`INSERT INTO document VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        document.id, document.title, document.documentType, document.issuingAuthority, document.promulgatedAt,
        document.effectiveAt, document.validityStatus, document.officialUrl, document.contentHash,
        document.fetchedAt, document.sourceId, evidence ? JSON.stringify(evidence) : null,
        document.bodyText, document.snapshotHash, document.snapshotPath, document.snapshotFormat,
      )
      const insertArticle = this.db.prepare('INSERT INTO article VALUES(?,?,?,?,?,?,?,?)')
      const insertFts = this.db.prepare('INSERT INTO article_fts(articleId,terms) VALUES(?,?)')
      for (const article of articles) {
        insertArticle.run(article.id, article.documentId, article.articleNumber, article.heading, article.text, article.textHash, article.start, article.end)
        insertFts.run(article.id, indexText(article.heading + '\n' + article.text))
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return { document, articles }
  }

  /** Preserve unverified downloads without creating a document or asserting validity. */
  saveSnapshot(content: string, format: 'HTML' | 'TEXT') {
    if (this.readOnly) throw new Error('Read-only authority corpus')
    authorityImportSchema.shape.snapshot.parse({ content, format })
    const snapshotHash = authorityHash(content)
    const snapshotPath = resolve(this.snapshots, snapshotHash + (format === 'HTML' ? '.html' : '.txt'))
    this.assertSnapshotPath(snapshotPath)
    // Content-addressed snapshots are immutable; a failed import leaves reusable source evidence.
    try { writeFileSync(snapshotPath, content, { encoding: 'utf8', flag: 'wx' }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || authorityHash(readFileSync(snapshotPath, 'utf8')) !== snapshotHash) throw error
    }
    return { snapshotHash, snapshotPath }
  }

  getDocument(id: string): AuthorityDocument | undefined {
    const row = this.db.prepare('SELECT * FROM document WHERE id = ?').get(id)
    if (!row) return undefined
    const document = authorityDocumentSchema.parse({ ...row, validityEvidence: row.validityEvidence ? JSON.parse(String(row.validityEvidence)) : undefined })
    this.validateSource(document)
    return document
  }

  getArticle(id: string): AuthorityArticle | undefined {
    const row = this.db.prepare('SELECT * FROM article WHERE id = ?').get(id)
    return row ? authorityArticleSchema.parse(row) : undefined
  }

  readSnapshot(documentId: string): string {
    const document = this.getDocument(documentId)
    if (!document) throw new Error(`Unknown authority document: ${documentId}`)
    this.assertSnapshotPath(document.snapshotPath)
    const snapshot = readFileSync(document.snapshotPath, 'utf8')
    if (authorityHash(snapshot) !== document.snapshotHash) throw new Error('Authority raw snapshot hash mismatch')
    return snapshot
  }

  search(input: AuthoritySearchInput): AuthoritySearchHit[] {
    const request = authoritySearchSchema.parse(input)
    return this.rank(request).slice(0, request.topK)
      .map(({ document, article, score, match }) => ({ document, article, score, match }))
  }

  /** Same bounded production candidates/ranking, before Top-K; diagnostic ranks are not applicability. */
  diagnoseSearch(input: AuthoritySearchInput): RankedAuthorityHit[] {
    return this.rank(authoritySearchSchema.parse(input))
  }

  /** One ranking implementation for both entries; each parses its own input exactly once. */
  private rank(request: z.infer<typeof authoritySearchSchema>): RankedAuthorityHit[] {
    const { tokens, queryWords, providerQuery } = formulateAuthorityFts(request.query, request.legalQuestion)
    if (tokens.length === 0) return []
    const filters: string[] = []
    const parameters: string[] = [providerQuery]
    if (request.documentTypes) {
      filters.push(`d.documentType IN (${request.documentTypes.map(() => '?').join(',')})`)
      parameters.push(...request.documentTypes)
    }
    if (request.validityStatuses) {
      filters.push(`d.validityStatus IN (${request.validityStatuses.map(() => '?').join(',')})`)
      parameters.push(...request.validityStatuses)
    }
    const rows = this.db.prepare(`SELECT a.id, bm25(article_fts) AS rank
      FROM article_fts JOIN article a ON a.id=article_fts.articleId JOIN document d ON d.id=a.documentId
      WHERE article_fts MATCH ? ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
      ORDER BY rank, a.id LIMIT 300`).all(...parameters)
    return rows.map((row, index) => {
      const article = this.getArticle(String(row.id))!
      const document = this.getDocument(article.documentId)!
      const match = authorityArticleRelevance(article.text, request.query, request.legalQuestion)
      const concept = authorityConceptMatch(article.text, request.query, request.legalQuestion)
      const task = retrievalTaskMatch(article.text, request.taskQuery ?? request.query, request.legalQuestion)
      // Primary-task eligibility and evidence eligibility coexist; evidence cannot veto the primary task.
      if (task.layered) match.relevanceSufficient = task.sufficient || concept.sufficient
      else if (concept.intent) match.relevanceSufficient = concept.sufficient
      const rankingSignals = rankAuthorityArticle({ body: article.text, heading: article.heading, title: document.title,
        documentType: document.documentType, query: request.query, taskQuery: request.taskQuery,
        question: request.legalQuestion, lexicalTerms: queryWords, ftsScore: Number(row.rank) })
      return { document, article, score: rankingSignals.score, match,
        rawRank: index + 1, ftsScore: Number(row.rank), rankingSignals }
    }).sort((a, b) => Number(b.match.relevanceSufficient) - Number(a.match.relevanceSufficient) || b.score - a.score || a.article.id.localeCompare(b.article.id))
      .map((hit, index) => ({ ...hit, finalRank: index + 1 }))
  }

  close(): void { this.db.close() }

  validateSource(document: Pick<AuthorityDocument, 'sourceId' | 'officialUrl' | 'documentType'>): void {
    const source = this.sources.find(item => item.id === document.sourceId)
    if (!source || !source.hosts.includes(new URL(document.officialUrl).hostname)
      || !source.documentTypes.includes(document.documentType)) throw new Error('Document is outside configured official source/type allowlist')
  }

  private assertSnapshotPath(path: string): void {
    const root = realpathSync(this.snapshots)
    const parent = realpathSync(dirname(path))
    const inside = relative(root, resolve(parent, path.slice(path.lastIndexOf(sep) + 1)))
    if (!inside || inside.startsWith('..' + sep) || inside === '..' || isAbsolute(inside)
      || !/^[a-f0-9]{64}\.(html|txt)$/.test(inside)) throw new Error('Snapshot path is outside corpus snapshot directory')
    if (existsSync(path) && realpathSync(path) !== resolve(root, inside)) throw new Error('Snapshot file redirects outside the corpus directory')
  }
}
