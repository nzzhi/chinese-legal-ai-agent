import type { ResearchWorkflowDependencies } from './researchWorkflow.js'
import type { ModelClient } from '../llm/modelClient.js'

export interface AcceptanceLimits {
  queries: number
  verifications: number
  httpRequests: number
  durationMs: number
}

export const defaultAcceptanceLimits: AcceptanceLimits = {
  queries: 6, verifications: 10, httpRequests: 30, durationMs: 300_000,
}

/** Only a leading --acceptance enables parsing; ordinary case text is unchanged. */
export function parseResearchArguments(args: string[]): { rawCase: string; limits?: AcceptanceLimits } {
  if (args[0] !== '--acceptance') return { rawCase: args.join(' ').trim() }
  const limits = { ...defaultAcceptanceLimits }
  const flags: Record<string, keyof AcceptanceLimits> = {
    '--max-queries': 'queries', '--max-verifications': 'verifications',
    '--max-http-requests': 'httpRequests', '--max-duration-ms': 'durationMs',
  }
  const seen = new Set<string>()
  let index = 1
  for (; index < args.length && args[index] !== '--'; index += 2) {
    const flag = args[index]
    const key = flags[flag]
    const value = args[index + 1]
    if (!key || seen.has(flag) || !value || !/^\d+$/.test(value)) {
      throw new Error('Acceptance usage: --acceptance [budget options] -- "case text"')
    }
    seen.add(flag)
    limits[key] = Number(value)
  }
  validateLimits(limits)
  const rawCase = args.slice(index + 1).join(' ').trim()
  if (args[index] !== '--' || !rawCase) throw new Error('Acceptance mode requires -- followed by case text')
  return { rawCase, limits }
}

function validateLimits(limits: AcceptanceLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new Error('Acceptance limits must be integers between 1 and 2147483647')
    }
  }
}

export class AcceptanceBudgetError extends Error {
  constructor(public readonly code: 'BUDGET_EXCEEDED' | 'DEADLINE_EXCEEDED', message: string) {
    super(message)
    this.name = 'AcceptanceBudgetError'
  }
}

type Counter = 'queries' | 'verifications' | 'httpRequests'

/** One instance per bounded CLI/workbench operation; never truncates business data. */
export class AcceptanceBudget {
  readonly limits: Readonly<AcceptanceLimits>
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly started = performance.now()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly counts = { queries: 0, verifications: 0, httpRequests: 0 }
  readonly completed: Array<{ operation: string; result: unknown }> = []

  constructor(limits: AcceptanceLimits) {
    validateLimits(limits)
    this.limits = { ...limits }
    this.timer = setTimeout(() => this.stop(new AcceptanceBudgetError(
      'DEADLINE_EXCEEDED', `Acceptance deadline exceeded after ${limits.durationMs}ms`,
    )), limits.durationMs)
  }

  private stop(error: AcceptanceBudgetError): void {
    if (!this.signal.aborted) this.controller.abort(error)
  }

  check(): void {
    if (!this.signal.aborted && performance.now() - this.started >= this.limits.durationMs) {
      this.stop(new AcceptanceBudgetError('DEADLINE_EXCEEDED', `Acceptance deadline exceeded after ${this.limits.durationMs}ms`))
    }
    this.signal.throwIfAborted()
  }

  consume(counter: Counter): void {
    this.check()
    // The Nth operation is allowed; attempting N+1 aborts the entire run.
    if (this.counts[counter] >= this.limits[counter]) {
      this.stop(new AcceptanceBudgetError('BUDGET_EXCEEDED', `Acceptance ${counter} limit ${this.limits[counter]} exhausted`))
      this.check()
    }
    this.counts[counter]++
  }

  hasRemaining(counter: Counter): boolean {
    this.check()
    return this.counts[counter] < this.limits[counter]
  }

  private canStartOptional(counter: 'queries' | 'verifications', requiredHttpRequests: number): boolean {
    this.check()
    // ponytail: keep optional case work behind the core budget and a 40s deadline margin.
    return this.counts[counter] < this.limits[counter]
      && this.limits.httpRequests - this.counts.httpRequests >= requiredHttpRequests
      && this.limits.durationMs - (performance.now() - this.started) > 40_000
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check()
    let rejectAbort!: (reason: unknown) => void
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(this.signal.reason)
    this.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await Promise.race([cancelled, operation()])
      this.check()
      return result
    } catch (error) {
      // Providers may wrap cancellation as transport errors. Restore task status.
      this.check()
      throw error
    } finally {
      this.signal.removeEventListener('abort', onAbort)
    }
  }

  /** At the network boundary, BELOW SiteAccessManager/cache. Refuse hidden redirects. */
  networkFetch(delegate: typeof fetch, onRequest?: () => void): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init)
      if (request.redirect !== 'error' && request.redirect !== 'manual') {
        throw new Error('Acceptance HTTP path must disable automatic redirects')
      }
      const signal = AbortSignal.any([request.signal, this.signal])
      signal.throwIfAborted()
      this.consume('httpRequests')
      onRequest?.()
      return delegate(request, { signal })
    }
  }

  /** ABOVE SiteAccessManager: also cancel queue waits and body snapshots. */
  cancellableFetch(delegate: typeof fetch): typeof fetch {
    return (input, init) => {
      this.check()
      const request = new Request(input, init)
      const signal = AbortSignal.any([request.signal, this.signal])
      return this.run(() => delegate(new Request(request, { signal })))
    }
  }

  model(client: ModelClient): ModelClient {
    return { chat: (request) => this.run(() => client.chat({
      ...request, signal: request.signal ? AbortSignal.any([request.signal, this.signal]) : this.signal,
    })) }
  }

  dependencies(d: ResearchWorkflowDependencies): ResearchWorkflowDependencies {
    const record = async <T>(operation: string, work: () => Promise<T>, counter?: Counter): Promise<T> => {
      if (counter) this.consume(counter)
      const result = await this.run(work)
      this.completed.push({ operation, result })
      return result
    }
    return {
      ...(d.conditionalAnalyzer ? { conditionalAnalyzer: { analyze: input => record('Conditional Analysis', () => d.conditionalAnalyzer!.analyze(input)) } } : {}),
      factExtractor: { extract: input => record('Fact Extraction', () => d.factExtractor.extract(input)) },
      caseClassifier: { classify: input => record('Classification', () => d.caseClassifier.classify(input)) },
      disputeIdentifier: { analyze: input => record('Dispute Identification', () => d.disputeIdentifier.analyze(input)) },
      legalQuestionDecomposer: { decompose: input => record('Legal Questions', () => d.legalQuestionDecomposer.decompose(input)) },
      legalQueryBuilder: { build: input => record('Search Queries', () => d.legalQueryBuilder.build(input)) },
      legalRetriever: {
        providerId: d.legalRetriever.providerId,
        ...(d.legalRetriever.formulateQueryPlans
          ? { formulateQueryPlans: (input, questions) => d.legalRetriever.formulateQueryPlans!(input, questions) }
          : {}),
        ...(d.legalRetriever.providerIdForQuery
          ? { providerIdForQuery: input => d.legalRetriever.providerIdForQuery!(input) }
          : {}),
        ...(d.legalRetriever.requestIdentity
          ? { requestIdentity: input => d.legalRetriever.requestIdentity!(input) }
          : {}),
        retrieve: input => record('Retrieval', () => d.legalRetriever.retrieve(input), 'queries'),
      },
      canStartRetrievalProviderCall: () => this.hasRemaining('queries'),
      canStartReferenceProviderCall: () => this.canStartOptional('queries', 1),
      canStartReferenceVerification: () => this.canStartOptional('verifications', 4),
      legalSourceVerifier: { verify: (input, signal) => record('Source Verification', () => d.legalSourceVerifier.verify(
        input, signal ? AbortSignal.any([signal, this.signal]) : this.signal,
      ), 'verifications') },
    }
  }

  snapshot() {
    return { limits: this.limits, counts: { ...this.counts }, elapsedMs: performance.now() - this.started }
  }

  dispose(): void { clearTimeout(this.timer) }
  cancel(): void { this.controller.abort(new Error('Workbench stopped')); this.dispose() }
}
