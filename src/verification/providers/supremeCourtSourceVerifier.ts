import { createHash, randomUUID } from 'node:crypto'
import type { LegalSourceVerifier } from '../legalSourceVerifier.js'
import { SourceVerificationError } from '../sourceVerificationError.js'
import {
  unobservedVerificationChecks, sourceVerificationRequestSchema, sourceVerificationResultSchema, verificationStatusFromChecks,
  type SourceVerificationChecks, type SourceVerificationRequest, type SourceVerificationResult,
  type VerificationCheck, type VerificationEvidence, type VerifiedLegalSource,
} from '../sourceVerificationSchema.js'
import { fetchSupremeCourtDetail, parseSupremeCourtDetailUrl } from './supremeCourtDetailHttp.js'
import { parseSupremeCourtDetail, supremeCourtDetailLimits, supremeCourtDetailParserId } from './supremeCourtDetailParser.js'

const origin = 'https://www.court.gov.cn'
const providerId = 'supreme-court-public-search-v1'

function check(status: VerificationCheck['status'], reason: string): VerificationCheck { return { status, reason } }

/** Only whitespace, NFC and an explicit punctuation table are normalized.
 * No lowercasing, semantic similarity, article-name guessing, or LLM comparison.
 */
export function normalizeVerificationTitle(title: string): string {
  const punctuation: Record<string, string> = {
    '（': '(', '）': ')', '，': ',', '：': ':', '；': ';', '！': '!', '？': '?',
    '“': '"', '”': '"', '‘': "'", '’': "'",
  }
  return title.normalize('NFC').replace(/[（），：；！？“”‘’]/g, (char) => punctuation[char]).replace(/\s+/g, '')
}

/** Independent source verifier. A VERIFIED result is a SOURCE_SNAPSHOT only;
 * it never changes the Candidate, its trust flags, or legal authority.
 */
export class SupremeCourtSourceVerifier implements LegalSourceVerifier {
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => Date

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date } = {}) {
    this.fetcher = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.now = options.now ?? (() => new Date())
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new SourceVerificationError('INVALID_INPUT', 'Verification timeout must be a positive supported integer')
    }
  }

  async verify(request: SourceVerificationRequest, signal?: AbortSignal): Promise<SourceVerificationResult> {
    const parsed = sourceVerificationRequestSchema.safeParse(request)
    if (!parsed.success) throw new SourceVerificationError('INVALID_INPUT', 'Verification input failed schema or membership validation', { cause: parsed.error })
    // Zod creates detached objects; no caller-owned state is read after this boundary.
    const input = parsed.data
    const retrieval = input.retrieval
    if (retrieval.providerId !== providerId) {
      throw new SourceVerificationError('UNSUPPORTED_PROVIDER', 'No verifier for this retrieval provider')
    }
    if (signal?.aborted) throw new SourceVerificationError('CANCELLED', 'Verification cancelled')
    const candidate = retrieval.sources.find((source) => source.sourceId === input.candidateSourceId)!
    const record = candidate.record
    if (!record.sourceUrl) throw new SourceVerificationError('INVALID_INPUT', 'Supreme Court verification requires a source URL')
    const verificationId = `verification-${randomUUID()}`
    const checks = unobservedVerificationChecks()
    let evidence: VerificationEvidence = { requestedUrl: record.sourceUrl, redirects: [] }
    const finish = (verifiedSource?: VerifiedLegalSource): SourceVerificationResult => {
      const result = {
        verificationId, candidateSourceId: candidate.sourceId, retrievalId: retrieval.retrievalId,
        legalQuestionId: retrieval.legalQuestionId, legalSearchQueryId: retrieval.legalSearchQueryId,
        providerId: retrieval.providerId, providerSourceId: record.providerSourceId,
        status: verificationStatusFromChecks(checks),
        checkedAt: verifiedSource?.verifiedAt ?? this.timestamp(),
        checks, evidence, ...(verifiedSource ? { verifiedSource } : {}),
      }
      const validated = sourceVerificationResultSchema.safeParse(result)
      if (!validated.success) throw new SourceVerificationError('INTERNAL_ERROR', 'Verification result is internally inconsistent', { cause: validated.error })
      return validated.data
    }

    if (record.sourceOrigin !== origin) {
      checks.sourceOrigin = check('MISMATCH', 'Candidate sourceOrigin does not equal the supported official origin')
      return finish()
    }
    const requested = parseSupremeCourtDetailUrl(record.sourceUrl)
    if (!requested) {
      checks.url = check('MISMATCH', 'Candidate URL is outside the supported HTTPS detail URL policy')
      return finish()
    }
    if (requested.providerSourceId !== record.providerSourceId) {
      checks.sourceIdentity = check('MISMATCH', 'Candidate providerSourceId conflicts with its detail URL')
      return finish()
    }

    const controller = new AbortController()
    let abortError = new SourceVerificationError('TIMEOUT', 'Source verification timed out')
    const forwardAbort = () => {
      abortError = new SourceVerificationError('CANCELLED', 'Source verification cancelled by caller')
      controller.abort()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      signal?.addEventListener('abort', forwardAbort, { once: true })
      if (signal?.aborted) forwardAbort()
      timer = setTimeout(() => controller.abort(), this.timeoutMs)
      const operation = fetchSupremeCourtDetail(requested.url, record.providerSourceId, {
        fetch: this.fetcher, signal: controller.signal,
      })
      const fetched = await Promise.race([operation, cancelled])
      if (controller.signal.aborted) throw abortError
      evidence = {
        requestedUrl: record.sourceUrl, finalUrl: fetched.finalUrl, httpStatus: fetched.httpStatus,
        contentType: fetched.contentType, fetchedAt: fetched.fetchedAt,
        cacheStatus: fetched.cacheStatus, cacheExpiresAt: fetched.cacheExpiresAt,
        responseBodyHash: fetched.responseBodyHash, responseBytes: fetched.responseBytes,
        extractedProviderSourceId: fetched.extractedProviderSourceId, redirects: fetched.redirects,
      }
      if (fetched.identityMismatch) {
        checks.url = check('MISMATCH', fetched.identityMismatch)
        checks.sourceIdentity = check('MISMATCH', 'Observed URL/redirect identity conflicts with the Candidate')
        return finish()
      }
      checks.url = check('VERIFIED', 'Requested and actual final URL satisfy the explicit HTTPS detail policy')
      checks.sourceOrigin = check('VERIFIED', 'Actual response URL is on the allowed official origin')
      checks.sourceIdentity = check('VERIFIED', 'Candidate and actual final URL share the same category and numeric ID')
      if (fetched.httpStatus === 404 || fetched.httpStatus === 410) {
        checks.existence = check('MISMATCH', `Detail page returned HTTP ${fetched.httpStatus}`)
        return finish()
      }
      if (fetched.httpStatus !== 200 || fetched.html === undefined || !fetched.finalUrl) {
        throw new SourceVerificationError('INVALID_RESPONSE', 'Detail fetch did not provide a usable response')
      }
      checks.existence = check('VERIFIED', 'Actual detail page returned HTTP 200')
      const observedAt = this.timestamp()
      const actual = parseSupremeCourtDetail(fetched.html, observedAt)
      const contentHash = createHash('sha256').update(actual.content, 'utf8').digest('hex')
      evidence = {
        ...evidence, parserId: supremeCourtDetailParserId, parsedTitle: actual.title,
        publicationDateRaw: actual.publicationDateRaw, parsedPublicationDate: actual.publicationDate,
        canonicalUrls: actual.canonicalUrls, contentHash, contentLength: actual.content.length,
      }
      checks.title = normalizeVerificationTitle(record.title) === normalizeVerificationTitle(actual.title)
        ? check('VERIFIED', 'Candidate title equals detail title under explicit whitespace/punctuation normalization')
        : check('MISMATCH', 'Candidate title differs from the observed detail title')
      checks.content = actual.content.length >= supremeCourtDetailLimits.minContentChars
        ? check('VERIFIED', 'Unique article text extracted above minimum length without local truncation')
        : check('UNKNOWN', 'Article text is shorter than the minimum snapshot threshold')
      checks.completeness = check(actual.completeness, actual.completenessReason)
      checks.publicationDate = check(actual.publicationDateStatus, actual.publicationDateReason)
      if (actual.canonicalUrls.length === 0) {
        checks.canonicalUrl = check('UNKNOWN', 'Page does not declare a canonical URL; final URL was independently checked')
      } else if (actual.canonicalUrls.length !== 1) {
        checks.canonicalUrl = check('MISMATCH', 'Page declares multiple canonical URLs')
      } else {
        const declared = actual.canonicalUrls[0]
        const canonical = parseSupremeCourtDetailUrl(declared.startsWith('/') ? origin + declared : declared)
        checks.canonicalUrl = canonical?.url === fetched.finalUrl && canonical.providerSourceId === record.providerSourceId
          ? check('VERIFIED', 'Declared canonical URL matches the fetched detail identity')
          : check('MISMATCH', 'Declared canonical URL is unsafe or identifies a different detail page')
      }
      const snippet = record.content.normalize('NFC').replace(/\s+/g, '').replace(/(?:\.{3}|…)+$/u, '')
      const fullText = actual.content.normalize('NFC').replace(/\s+/g, '')
      checks.snippet = record.locator?.startsWith('SEARCH_SNIPPET;') && snippet.length >= 20 && fullText.includes(snippet)
        ? check('VERIFIED', 'Entire non-ellipsis search snippet appears literally in the article after whitespace normalization')
        : check('UNKNOWN', 'No reliable complete literal snippet match; no semantic inference attempted')

      if (verificationStatusFromChecks(checks) !== 'VERIFIED') return finish()
      return finish({
        verificationScope: 'SOURCE_SNAPSHOT', contentTrust: 'UNTRUSTED',
        candidateSourceId: candidate.sourceId, verificationId, verifiedAt: this.timestamp(),
        providerSourceId: record.providerSourceId, sourceUrl: fetched.finalUrl, sourceOrigin: origin,
        sourceType: 'OTHER_LEGAL_MATERIAL', legalStatus: 'UNKNOWN',
        title: actual.title, content: actual.content, contentHash, locator: 'FULL_DETAIL_PAGE_TEXT',
        ...(checks.publicationDate.status === 'VERIFIED' ? { publicationDate: actual.publicationDate } : {}),
      })
    } catch (error) {
      if (error instanceof SourceVerificationError) {
        error.evidence = { ...evidence, ...error.evidence, redirects: error.evidence?.redirects.length ? error.evidence.redirects : evidence.redirects }
        if (process.env.RESEARCH_VERIFICATION_DEBUG === '1') {
          console.error('[supreme-court-verification]', JSON.stringify({ code: error.code, message: error.message, ...error.evidence }))
        }
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private timestamp(): string {
    const date = this.now()
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new SourceVerificationError('INVALID_INPUT', 'Verification clock returned an invalid time')
    }
    return date.toISOString()
  }
}

