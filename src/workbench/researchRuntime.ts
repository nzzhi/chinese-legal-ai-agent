import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { AuthorityCorpus } from '../authority/authorityCorpus.js'
import { ModelCaseClassifier } from '../classification/caseClassifier.js'
import { ModelDisputeIdentifier } from '../classification/disputeIdentifier.js'
import { loadModelConfig } from '../config/modelConfig.js'
import { ModelFactExtractor } from '../extraction/factExtractor.js'
import { SiteAccessManager } from '../http/siteAccess.js'
import type { AcceptanceBudget } from '../integration/acceptanceBudget.js'
import type { ResearchWorkflowDependencies } from '../integration/researchWorkflow.js'
import { InstrumentedModelClient, ResearchInstrumentation } from '../integration/researchInstrumentation.js'
import { ModelLegalQueryBuilder } from '../legalQuery/legalQueryBuilder.js'
import type { QueryDomainDiagnostic } from '../legalQuery/queryDomainDiagnostic.js'
import { ModelLegalQuestionDecomposer } from '../legalQuestion/legalQuestionDecomposer.js'
import { OpenAICompatibleModelClient } from '../llm/modelClient.js'
import type { ModelClient } from '../llm/modelClient.js'
import type { NormativeObserver } from '../legalRule/normativeRule.js'
import { ModelRouter } from '../llm/modelRouter.js'
import { ProviderLegalRetriever } from '../retrieval/legalRetriever.js'
import { LocalAuthorityProvider, AuthorityReferenceRetriever } from '../retrieval/providers/localAuthorityProvider.js'
import { SupremeCourtSearchProvider } from '../retrieval/providers/supremeCourtSearchProvider.js'
import { LocalAuthorityVerifier, AuthorityReferenceVerifier } from '../verification/providers/localAuthorityVerifier.js'
import { SupremeCourtSourceVerifier } from '../verification/providers/supremeCourtSourceVerifier.js'
import { WorkspaceError } from '../caseEvidence/workspace.js'
import { ModelConditionalAnalyzer } from '../legalRule/conditionalAnalysis.js'
import { ResearchCache } from './researchCache.js'
import { readFileSync } from 'node:fs'
import { PreliminaryWorkflow } from '../assistant/preliminaryWorkflow.js'
import { preliminaryDocumentContexts } from '../assistant/preliminaryQuality.js'
import { publicLegalAccess } from '../http/publicLegalAccess.js'

export type WorkbenchRuntimeFactory = (budget: AcceptanceBudget, options?: {
  onQueryDomainDiagnostic?: (diagnostic: QueryDomainDiagnostic) => void;
  modelClient?: ModelClient; onNormativeStage?: NormativeObserver; createCaseId?: () => string;
  localAuthoritiesOnly?: boolean;
  mode?: 'PRELIMINARY' | 'STRICT';
  questionConcurrency?: 1 | 2; cacheRoot?: string; cacheReuse?: boolean; onModelReuse?: () => void;
  onQuestion?: (id: string, status: 'QUEUED' | 'STARTED' | 'COMPLETED' | 'BLOCKED' | 'REUSED') => void;
}) => { dependencies: ResearchWorkflowDependencies;
  instrumentation?: ResearchInstrumentation; preliminary?: PreliminaryWorkflow; close(): void }
/** Lazy assembly of existing production stages; no model/network activity until a user starts work. */
export const createWorkbenchRuntime: WorkbenchRuntimeFactory = (budget, options) => {
  let config
  try { config = loadModelConfig() } catch { throw new WorkspaceError('尚未正确配置研究模型，请检查本地 .env 中的模型配置。', 503) }
  const instrumentation = new ResearchInstrumentation()
  // Run-scoped like the CLI and golden entries; process-wide it let one 403 poison every later run.
  const siteAccess = new SiteAccessManager({ minIntervalMs: 1500 })
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  let cache: ResearchCache | undefined
  if (options?.cacheRoot && options.mode !== 'PRELIMINARY') {
    const cacheVersion = createHash('sha256').update(JSON.stringify([config.provider, config.baseURL, config.flashModel, config.proModel]))
    for (const file of ['../legalRule/conditionalAnalysis', '../legalRule/normativeRule', '../report/conditionalResearchReport']) {
      cacheVersion.update(readFileSync(new URL(`${file}.${extension}`, import.meta.url)))
    }
    cache = new ResearchCache(join(options.cacheRoot, cacheVersion.digest('hex')), budget.signal, options.cacheReuse)
  }
  const transport = budget.model(options?.modelClient ?? new OpenAICompatibleModelClient(config, {
    fetch: budget.networkFetch(fetch),
  }))
  const instrumented = new InstrumentedModelClient(transport, instrumentation)
  const client = cache ? cache.model(instrumented, options?.onModelReuse) : instrumented
  const router = new ModelRouter(config)
  const publicAccess = publicLegalAccess()
  const siteFetch = (onRequest: () => void) => publicAccess(budget.cancellableFetch(siteAccess.createFetch(budget.networkFetch(fetch, onRequest))))
  const retrievalFetch = siteFetch(() => instrumentation.recordRetrievalHttpRequest())
  const verificationFetch = siteFetch(() => instrumentation.recordVerificationHttpRequest())
  const corpus = new AuthorityCorpus(process.env.LEGAL_AUTHORITY_DB_PATH ?? resolve('.local/legal-authority/authority.sqlite'),
    { readOnly: options?.mode === 'PRELIMINARY' })
  const localOnly = options?.localAuthoritiesOnly
  const queryBuilder = new ModelLegalQueryBuilder(client, router, undefined, undefined, options?.onQueryDomainDiagnostic)
  const dependencies: ResearchWorkflowDependencies = {
      factExtractor: new ModelFactExtractor(client, router, options?.createCaseId ?? (() => `case-${randomUUID()}`)),
      caseClassifier: new ModelCaseClassifier(client, router),
      disputeIdentifier: new ModelDisputeIdentifier(client, router),
      legalQuestionDecomposer: new ModelLegalQuestionDecomposer(client, router),
      conditionalAnalyzer: new ModelConditionalAnalyzer(client, router, options?.onNormativeStage, {
        concurrency: options?.questionConcurrency ?? 2, signal: budget.signal,
        load: cache ? input => cache.load(input) : undefined,
        save: cache ? (input, result) => cache.save(input, result) : undefined,
        onQuestion: options?.onQuestion,
      }),
      legalQueryBuilder: { build:async questions=>{
        const plans=await queryBuilder.build(questions), publicPlan=plans.find(p=>p.searchOnline)
        return !localOnly&&publicPlan ? [...plans,{...publicPlan,id:`${publicPlan.id}-public`,sourcePurpose:'REFERENCE' as const,
          providerQuery:publicPlan.query,fallbackQueries:[],fallbackRejections:[]}] : plans
      } },
      legalRetriever: localOnly ? new ProviderLegalRetriever(new LocalAuthorityProvider(corpus))
        : new AuthorityReferenceRetriever(new ProviderLegalRetriever(new LocalAuthorityProvider(corpus)),
          new ProviderLegalRetriever(new SupremeCourtSearchProvider({ fetch: retrievalFetch }))),
      legalSourceVerifier: localOnly ? new LocalAuthorityVerifier(corpus)
        : new AuthorityReferenceVerifier(new LocalAuthorityVerifier(corpus), new SupremeCourtSourceVerifier({ fetch: verificationFetch })),
    }
  const bounded = budget.dependencies(dependencies)
  return {
    instrumentation, dependencies,
    preliminary: options?.mode === 'PRELIMINARY' ? new PreliminaryWorkflow(client, router, bounded.legalRetriever, bounded.legalSourceVerifier,
      { instrumentation, signal: budget.signal, createCaseId: options.createCaseId, onlineSearch: !localOnly,
        canSupplement: kind => {
          budget.check()
          const { limits, counts, elapsedMs } = budget.snapshot()
          // Public worst case: robots + search + 3 details with 2 redirects each + report model HTTP.
          return counts.queries < limits.queries && limits.verifications - counts.verifications >= 3
            && limits.httpRequests - counts.httpRequests >= (kind === 'PUBLIC' ? 12 : 1)
            && limits.durationMs - elapsedMs > (kind === 'PUBLIC' ? 48_000 : 8_000)
        },
        documentContexts: sources => preliminaryDocumentContexts(sources, corpus) }) : undefined,
    close: () => corpus.close(),
  }
}
