import { ModelCaseClassifier } from './classification/caseClassifier.js'
import { ModelDisputeIdentifier } from './classification/disputeIdentifier.js'
import { loadModelConfig } from './config/modelConfig.js'
import { ModelFactExtractor } from './extraction/factExtractor.js'
import { SiteAccessManager } from './http/siteAccess.js'
import {
  InstrumentedModelClient,
  ResearchInstrumentation,
  createCountingFetch,
} from './integration/researchInstrumentation.js'
import { ResearchWorkflow } from './integration/researchWorkflow.js'
import { ModelLegalQueryBuilder } from './legalQuery/legalQueryBuilder.js'
import { ModelLegalQuestionDecomposer } from './legalQuestion/legalQuestionDecomposer.js'
import { ModelConditionalAnalyzer } from './legalRule/conditionalAnalysis.js'
import { OpenAICompatibleModelClient } from './llm/modelClient.js'
import { ModelRouter } from './llm/modelRouter.js'
import { ProviderLegalRetriever } from './retrieval/legalRetriever.js'
import { isReferenceCase } from './retrieval/sourceRole.js'
import { SupremeCourtSearchProvider } from './retrieval/providers/supremeCourtSearchProvider.js'
import { SupremeCourtSourceVerifier } from './verification/providers/supremeCourtSourceVerifier.js'
import { AuthorityCorpus } from './authority/authorityCorpus.js'
import { LocalAuthorityProvider, AuthorityReferenceRetriever } from './retrieval/providers/localAuthorityProvider.js'
import { LocalAuthorityVerifier, AuthorityReferenceVerifier } from './verification/providers/localAuthorityVerifier.js'
import { resolve } from 'node:path'
import { saveResearchArtifacts } from './researchOutput.js'
import { AcceptanceBudget, AcceptanceBudgetError, parseResearchArguments } from './integration/acceptanceBudget.js'
import type { ResearchWorkflowDependencies, WorkflowStageEvent } from './integration/researchWorkflow.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  safeAcceptanceFailureDiagnostic, safeDiagnosticCode, safeErrorCode, safeFailureDiagnostic,
  summarizeUnexecutedQueries, type FailureDiagnostic,
} from './integration/failureDiagnostic.js'
import type { LegalQuestion } from './legalQuestion/legalQuestionSchema.js'
import type { PlannedLegalSearchQuery } from './legalQuery/legalQuerySchema.js'
import type { RetrievalAttemptObservation } from './retrieval/queryFallback.js'
import type { ExecutionStatus, ResearchStatus, QuestionResearchStatus } from './integration/researchProgress.js'

const args = process.argv.slice(2)
const strict = args[0] === '--strict' || args[0] === '--acceptance'
const { rawCase, limits } = parseResearchArguments(args[0] === '--strict' ? args.slice(1) : args)

if (!rawCase) {
  throw new Error('Usage: npm run research -- "<案件事实>"')
}

if (!strict) {
  await (await import('./assistant/cli.js')).runPreliminaryCli(rawCase)
  process.exit(process.exitCode ?? 0)
}

const config = loadModelConfig()
const budget = limits ? new AcceptanceBudget(limits) : undefined
const acceptanceEvents: Array<Omit<WorkflowStageEvent, 'error'> & { errorCode?: string; diagnostic?: FailureDiagnostic }> = []
const providerFailures: unknown[] = []
const verificationResults: unknown[] = []
const retrievalAttempts: RetrievalAttemptObservation[] = []
let acceptanceStatus = 'INCOMPLETE'
let executionStatus: ExecutionStatus = 'FAILED'
let researchStatus: ResearchStatus = 'INDETERMINATE'
let questionResearchSummary: Array<{ legalQuestionId: string; status: QuestionResearchStatus }> = []
let acceptanceErrorCode: string | undefined
let acceptanceDiagnostic: FailureDiagnostic | undefined
let artifactPaths: { jsonPath: string; docxPath?: string; pdfPath?: string } | undefined
const instrumentation = new ResearchInstrumentation()
const transportClient = new OpenAICompatibleModelClient(config, budget ? { fetch: budget.networkFetch(fetch) } : {})
const modelClient = new InstrumentedModelClient(budget ? budget.model(transportClient) : transportClient, instrumentation)
const router = new ModelRouter(config)
const siteAccess = new SiteAccessManager()
const siteFetch = (onRequest: () => void) => {
  const network = budget ? budget.networkFetch(fetch, onRequest) : createCountingFetch(fetch, onRequest)
  const managed = siteAccess.createFetch(network)
  return budget ? budget.cancellableFetch(managed) : managed
}
const retrievalFetch = siteFetch(() => instrumentation.recordRetrievalHttpRequest())
const verificationFetch = siteFetch(() => instrumentation.recordVerificationHttpRequest())
const stages = [
  'Fact Extraction', 'Classification', 'Dispute Identification',
  'Legal Questions', 'Search Queries', 'Retrieval', 'Source Verification', 'Conditional Analysis',
] as const
const authorityCorpus = new AuthorityCorpus(process.env.LEGAL_AUTHORITY_DB_PATH ?? resolve('.local/legal-authority/authority.sqlite'))

const dependencies: ResearchWorkflowDependencies = {
  factExtractor: new ModelFactExtractor(modelClient, router),
  caseClassifier: new ModelCaseClassifier(modelClient, router),
  disputeIdentifier: new ModelDisputeIdentifier(modelClient, router),
  legalQuestionDecomposer: new ModelLegalQuestionDecomposer(modelClient, router),
  conditionalAnalyzer: new ModelConditionalAnalyzer(modelClient, router),
  legalQueryBuilder: new ModelLegalQueryBuilder(modelClient, router),
  legalRetriever: new AuthorityReferenceRetriever(new ProviderLegalRetriever(new LocalAuthorityProvider(authorityCorpus)),
    new ProviderLegalRetriever(new SupremeCourtSearchProvider({ fetch: retrievalFetch }))),
  legalSourceVerifier: new AuthorityReferenceVerifier(new LocalAuthorityVerifier(authorityCorpus),
    new SupremeCourtSourceVerifier({ fetch: verificationFetch })),
}
const workflow = new ResearchWorkflow(budget ? budget.dependencies(dependencies) : dependencies, {
  instrumentation,
  onVerification: (result) => {
    const summary = { status: result.status, errorCode: result.failure ? safeDiagnosticCode(result.failure.code) : undefined }
    if (budget) verificationResults.push(summary)
    console.log('Source verification:', summary)
  },
  onProviderFailure: (failure) => {
    const summary = { errorCode: safeDiagnosticCode(failure.errorCode), fallbackAttempted: failure.fallbackAttempted }
    if (budget) providerFailures.push(summary)
    console.warn('Retrieval provider unavailable:', summary)
  },
  onRetrievalAttempt: (observation) => {
    if (!budget) return
    retrievalAttempts.push({
      ...observation,
      legalQuestionId: safeDiagnosticId(observation.legalQuestionId),
      legalSearchQueryId: safeDiagnosticId(observation.legalSearchQueryId),
      ...(observation.reusedFromRetrievalId
        ? { reusedFromRetrievalId: safeDiagnosticId(observation.reusedFromRetrievalId) } : {}),
    })
  },
  onStage: (event) => {
    if (budget) {
      const { error, ...state } = event
      acceptanceEvents.push({ ...state, errorCode: error ? safeErrorCode(error) : undefined,
        diagnostic: error ? safeAcceptanceFailureDiagnostic(error) : undefined })
    }
    if (event.status === 'STARTED') {
      console.log(`\n[${stages.indexOf(event.stage) + 1}/${stages.length}] ${event.stage}...`)
    } else if (event.status === 'SUCCEEDED') {
      console.log(`✓ ${event.stage} completed (${((event.durationMs ?? 0) / 1000).toFixed(1)}s)`)
    } else if (event.stage === 'Retrieval' && !event.error) {
      console.warn(event.status === 'FAILED' ? '⚠ Retrieval unavailable' : '⚠ Research continuing in degraded mode')
    } else {
      console.log(`✗ ${event.stage} failed`)
    }
  },
})

try {
  console.log('Chinese Legal Research Agent')
  budget?.check()
  const result = await workflow.run(rawCase)
  executionStatus = result.executionStatus
  researchStatus = result.researchStatus
  questionResearchSummary = result.authorityCoverage.map(item => ({
    legalQuestionId: safeDiagnosticId(item.legalQuestionId), status: item.status,
  }))
  budget?.check()
  console.log('Verification statistics:', result.verificationStatistics)
  const save = async () => {
    const artifacts = await saveResearchArtifacts(result, undefined, budget ? {
      signal: budget.signal, check: () => budget.check(),
    } : {})
    artifactPaths = { jsonPath: artifacts.jsonPath, docxPath: artifacts.docxPath, pdfPath: artifacts.pdfPath }
    return artifacts
  }
  const artifacts = await (budget ? budget.run(save) : save())
  const candidateCount = result.retrievedQueries.reduce((count, item) => count + item.retrieval.sources.length, 0)
  const snapshotCount = result.candidateVerifications.filter((item) => item.result.verifiedSource !== undefined).length
  const coreVerifications = result.candidateVerifications.filter(({ query, candidate, result: verification }) =>
    query.sourcePurpose !== 'REFERENCE' && !isReferenceCase(candidate, verification.verifiedSource?.title))
  const partial = result.executionStatus !== 'COMPLETE'
  if (partial) console.log(`✓ Partial workflow output saved: ${artifacts.jsonPath}`)
  console.log(`执行状态 ${result.executionStatus}；法律研究状态 ${result.researchStatus}：${result.legalQuestions.length} 个法律问题，${result.legalSearchQueries.length} 个查询，${candidateCount} 个候选来源，${snapshotCount} 个 Verified Source Snapshot。`)
  console.log(`运行耗时：${(result.metrics.totalDurationMs / 1000).toFixed(2)} 秒`)
  console.log(`JSON 文件：${artifacts.jsonPath}`)
  if (artifacts.docxPath) console.log(`DOCX 文件：${artifacts.docxPath}`)
  if (artifacts.pdfPath) console.log(`PDF 文件：${artifacts.pdfPath}`)
    if (artifacts.htmlPath) console.log(`用户 HTML 报告：${artifacts.htmlPath}`)
    if (artifacts.markdownPath) console.log(`用户 Markdown 报告：${artifacts.markdownPath}`)
  for (const error of artifacts.errors) console.error('报告导出未全部成功：', safeErrorCode(error), safeFailureDiagnostic(error))
  if (artifacts.errors.length) process.exitCode = 1
  acceptanceStatus = artifacts.errors.length ? 'EXPORT_FAILED' : partial
    || coreVerifications.some(({ result: verification }) =>
      verification.status === 'FAILED' || verification.status === 'PARTIALLY_VERIFIED')
    || result.retrievedQueries.some(item => item.query.sourcePurpose !== 'REFERENCE' && !item.retrieval.complete)
    ? 'DEGRADED' : 'COMPLETE'
} catch (error) {
  executionStatus = 'FAILED'
  researchStatus = 'INDETERMINATE'
  acceptanceErrorCode = safeErrorCode(error)
  acceptanceDiagnostic = budget ? safeAcceptanceFailureDiagnostic(error) : safeFailureDiagnostic(error)
  acceptanceStatus = error instanceof AcceptanceBudgetError ? 'ABORTED' : 'FAILED'
  console.error(budget ? 'Acceptance incomplete:' : 'Research workflow failed:',
    acceptanceErrorCode, safeFailureDiagnostic(error))
  process.exitCode = 1
} finally {
  authorityCorpus.close()
  if (budget) {
    budget.dispose()
    // This diagnostic is not a successful ResearchWorkflowResult or resumable checkpoint.
    const path = fileURLToPath(new URL(`../output/acceptance-${randomUUID()}.json`, import.meta.url))
    await mkdir(fileURLToPath(new URL('../output/', import.meta.url)), { recursive: true, mode: 0o700 })
    const completedResult = <T>(operation: string): T | undefined =>
      budget.completed.find((entry) => entry.operation === operation)?.result as T | undefined
    const questions = completedResult<LegalQuestion[]>('Legal Questions') ?? []
    const queries = completedResult<PlannedLegalSearchQuery[]>('Search Queries') ?? []
    await writeFile(path, JSON.stringify({
      status: acceptanceStatus, executionStatus, researchStatus, questionResearchSummary,
      errorCode: acceptanceErrorCode, diagnostic: acceptanceDiagnostic, budget: budget.snapshot(),
      stages: acceptanceEvents, completed: budget.completed.map(({ operation }) => ({ operation })), providerFailures, verificationResults,
      legalQuestionSummary: questions.map(({ id, issueId, importance, questionType, relatedFactIds }) => ({
        id: safeDiagnosticId(id), issueId: safeDiagnosticId(issueId), importance, questionType,
        relatedFactIds: relatedFactIds.map(safeDiagnosticId),
      })),
      legalQuerySummary: queries.map(({ id, legalQuestionId, fallbackQueries, fallbackRejections }) => ({
        id: safeDiagnosticId(id), legalQuestionId: safeDiagnosticId(legalQuestionId),
        fallbackCount: fallbackQueries.length,
        fallbackQueryIds: fallbackQueries.map((fallback) => safeDiagnosticId(fallback.id)),
        fallbackRejections: fallbackRejections ?? [],
      })),
      retrievalAttempts,
      unexecutedQuerySummary: summarizeUnexecutedQueries(retrievalAttempts),
      metrics: instrumentation.snapshot(budget.snapshot().elapsedMs), artifacts: artifactPaths,
    }, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(`Acceptance status=${acceptanceStatus}; executionStatus=${executionStatus}; researchStatus=${researchStatus}; diagnostics: ${path}`)
  }
}

function safeDiagnosticId(value: string): string {
  const generatedId = /^(?:question|issue|fact|event|dispute)-[1-9]\d{0,9}$/.test(value)
    || /^query-[1-9]\d{0,9}(?:-fallback-[1-9]\d{0,9})?$/.test(value)
    || /^retrieval-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  return generatedId
    ? value : `sha256:${createHash('sha256').update(value).digest('hex')}`
}
