import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AuthorityCorpus, splitAuthorityArticles } from './authorityCorpus.js'
import { authorityDocumentInputSchema, authorityHash } from './authoritySchema.js'
import { officialAuthorityParserHosts, officialAuthorityParsers, parseOfficialAuthorityHtml } from './officialAuthorityParser.js'

export const authoritySnapshotManifestSchema = z.strictObject({
  document: authorityDocumentInputSchema,
  snapshotPath: z.string().min(1),
  snapshotFormat: z.enum(['HTML', 'TEXT']),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  parser: z.enum(officialAuthorityParsers).optional(),
  expectedArticleCount: z.number().int().min(1).max(5000),
})

export function assertCompleteAuthorityBody(documentId: string, body: string, expected: number) {
  const articles = splitAuthorityArticles(documentId, body)
  if (articles.length !== expected) throw new Error(`Incomplete document: expected ${expected} articles, found ${articles.length}`)
  for (let index = 0; index < articles.length; index++) {
    const number = index + 1
    const digits = String(number)
    const chinese = [...digits].map((digit, i) => Number(digit)
      ? '零一二三四五六七八九'[Number(digit)] + ['', '十', '百', '千'][digits.length - i - 1]
      : '零').join('').replace(/零+/gu, '零').replace(/零$/u, '').replace(/^一十/u, '十')
    if (![ `第${chinese}条`, `第${number}条` ].includes(articles[index].articleNumber)) {
      throw new Error(`Incomplete article sequence at ${number}: ${articles[index].articleNumber}`)
    }
  }
  return articles
}

function readUtf8(path: string, maxBytes: number) {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Controlled input must be a regular file within its size limit')
  const bytes = readFileSync(path)
  if (bytes.length > maxBytes) throw new Error('Controlled input exceeds its size limit')
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** One explicit local official snapshot; no HTTP, no model, no implicit EFFECTIVE upgrade. */
export function importAuthoritySnapshotFile(corpus: AuthorityCorpus, manifestPath: string, now = new Date()) {
  const manifest = authoritySnapshotManifestSchema.parse(JSON.parse(readUtf8(resolve(manifestPath), 64 * 1024)))
  const path = resolve(dirname(resolve(manifestPath)), manifest.snapshotPath)
  const raw = readUtf8(path, 2 * 1024 * 1024)
  if (authorityHash(raw) !== manifest.snapshotHash) throw new Error('Controlled snapshot hash does not match manifest')
  const document = manifest.document
  corpus.validateSource(document)
  const age = now.getTime() - Date.parse(document.fetchedAt)
  const reviewAge = document.validityEvidence ? now.getTime() - Date.parse(document.validityEvidence.checkedAt) : age
  if (age < 0 || reviewAge < 0 || Math.max(age, reviewAge) > 30 * 24 * 60 * 60 * 1000) {
    throw new Error('STALE_SNAPSHOT: controlled snapshot/review must not be future-dated or older than 30 days')
  }
  if (manifest.snapshotFormat === 'HTML' && (!manifest.parser
    || officialAuthorityParserHosts[manifest.parser] !== new URL(document.officialUrl).hostname)) {
    throw new Error('HTML snapshot needs the inspected parser for this official host')
  }
  if (manifest.snapshotFormat === 'TEXT' && manifest.parser) throw new Error('TEXT snapshot must not select an HTML parser')
  const parsed = manifest.snapshotFormat === 'HTML'
    ? parseOfficialAuthorityHtml(raw, manifest.parser!, document.title) : undefined
  const bodyText = parsed?.content ?? raw
  const articles = assertCompleteAuthorityBody(document.id, bodyText, manifest.expectedArticleCount)
  const preamble = bodyText.slice(0, articles[0].start)
  if (!parsed && !preamble.split(/\r?\n/u).some(line => line.trim() === document.title)) {
    throw new Error('TEXT snapshot must contain the exact document title before its first article')
  }
  const evidence = document.validityEvidence
  const scope = parsed?.metadataText ?? preamble
  if (evidence && !scope.replace(/\s/gu, '').includes(evidence.excerpt.replace(/\s/gu, ''))) {
    throw new Error('Validity evidence must be in metadata of this document, not another article or related document')
  }
  const validityText = evidence?.excerpt.replace(/\s/gu, '') ?? ''
  // NPC detail exports label the selected version “有效”; require its entire own header,
  // including exact identity/dates, rather than accepting a bare word from related results.
  const npcClassification = { STATUTE: '法律', JUDICIAL_INTERPRETATION: '司法解释',
    ADMINISTRATIVE_REGULATION: '行政法规', NORMATIVE_DOCUMENT: '' }[document.documentType]
  const npcEffective = manifest.snapshotFormat === 'TEXT' && evidence?.method === 'CONTROLLED_REVIEW'
    && new URL(document.officialUrl).hostname === 'flk.npc.gov.cn'
    && new URL(document.officialUrl).pathname === '/detail' && !!new URL(document.officialUrl).searchParams.get('id')
    && !!npcClassification && !!document.promulgatedAt && !!document.effectiveAt
    && validityText === (document.title + '有效法律法规分类：' + npcClassification
      + '制定机关：' + document.issuingAuthority + '公布日期：' + document.promulgatedAt + '施行日期：' + document.effectiveAt)
    && preamble.replace(/\s/gu, '').startsWith(validityText)
  if (document.validityStatus === 'EFFECTIVE' && (!evidence
    || (!/(?:时效性|时效状态|文件状态|有效性)[〗】\]：:]*现行有效|全文有效/u.test(validityText) && !npcEffective))) {
    throw new Error('EFFECTIVE import needs an explicit current-validity statement, not a date-only inference')
  }
  const prior = corpus.getDocument(document.id)
  if (prior) {
    const { contentHash, snapshotHash, snapshotFormat, snapshotPath: _path, bodyText: priorBody, ...priorInput } = prior
    if (snapshotHash !== manifest.snapshotHash || contentHash !== authorityHash(bodyText)
      || snapshotFormat !== manifest.snapshotFormat || priorBody !== bodyText
      || !isDeepStrictEqual({ ...priorInput, validityEvidence: priorInput.validityEvidence },
        { ...document, validityEvidence: document.validityEvidence })) {
      throw new Error('Document ID already exists with different content or metadata; use a new version ID instead of silently overwriting')
    }
    corpus.readSnapshot(prior.id)
    if (!articles.every(article => isDeepStrictEqual(corpus.getArticle(article.id), article))) {
      throw new Error('Cached corpus articles differ from controlled snapshot')
    }
  }
  const imported = prior ? { document: prior, articles } : corpus.importDocument({ document, bodyText,
    snapshot: { content: raw, format: manifest.snapshotFormat } })
  return { status: prior ? 'CACHED' : 'IMPORTED', requests: 0, documentId: document.id,
    title: document.title, officialUrl: document.officialUrl, validityStatus: document.validityStatus,
    articleCount: imported.articles.length, firstArticle: imported.articles[0].articleNumber,
    lastArticle: imported.articles.at(-1)!.articleNumber, snapshotHash: imported.document.snapshotHash,
    contentHash: imported.document.contentHash, fetchedAt: document.fetchedAt,
    ...(evidence ? { validityEvidence: evidence } : {}) }
}
