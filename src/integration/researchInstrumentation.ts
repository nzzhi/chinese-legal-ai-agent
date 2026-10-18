import type { ModelClient, ModelRequest, ModelResponse } from '../llm/modelClient.js'

export type ResearchStageName =
  | 'Fact Extraction'
  | 'Classification'
  | 'Dispute Identification'
  | 'Legal Questions'
  | 'Search Queries'
  | 'Retrieval'
  | 'Source Verification'
  | 'Conditional Analysis'

export interface StageTiming {
  stage: ResearchStageName
  durationMs: number
}

export interface ResearchMetrics {
  totalDurationMs: number
  stageTimings: StageTiming[]
  llmCallCount: number
  llmCallsByModel: Record<string, number>
  /** Logical primary/fallback demand, including reuse and a budget-blocked attempt. */
  retrievalOperationCount: number
  retrievalReuseCount: number
  retrievalHttpRequestCount: number
  verificationOperationCount: number
  verificationHttpRequestCount: number
}

/**
 * Runtime-only accounting. It deliberately observes existing boundaries rather
 * than parsing, validating, or changing business payloads.
 */
export class ResearchInstrumentation {
  private readonly stageTimings: StageTiming[] = []
  private readonly llmCallsByModel = new Map<string, number>()
  private llmCallCount = 0
  private retrievalOperationCount = 0
  private retrievalReuseCount = 0
  private retrievalHttpRequestCount = 0
  private verificationOperationCount = 0
  private verificationHttpRequestCount = 0

  recordStage(stage: ResearchStageName, durationMs: number): void {
    this.stageTimings.push({ stage, durationMs })
  }

  recordModelCall(model: string): void {
    this.llmCallCount += 1
    this.llmCallsByModel.set(model, (this.llmCallsByModel.get(model) ?? 0) + 1)
  }

  recordRetrievalOperation(): void {
    this.retrievalOperationCount += 1
  }

  recordRetrievalReuse(): void {
    this.retrievalReuseCount += 1
  }

  recordRetrievalHttpRequest(): void {
    this.retrievalHttpRequestCount += 1
  }

  recordVerificationOperation(): void {
    this.verificationOperationCount += 1
  }

  recordVerificationHttpRequest(): void {
    this.verificationHttpRequestCount += 1
  }

  snapshot(totalDurationMs: number): ResearchMetrics {
    return {
      totalDurationMs,
      stageTimings: [...this.stageTimings],
      llmCallCount: this.llmCallCount,
      llmCallsByModel: Object.fromEntries(this.llmCallsByModel),
      retrievalOperationCount: this.retrievalOperationCount,
      retrievalReuseCount: this.retrievalReuseCount,
      retrievalHttpRequestCount: this.retrievalHttpRequestCount,
      verificationOperationCount: this.verificationOperationCount,
      verificationHttpRequestCount: this.verificationHttpRequestCount,
    }
  }
}

export class InstrumentedModelClient implements ModelClient {
  constructor(
    private readonly delegate: ModelClient,
    private readonly instrumentation: ResearchInstrumentation,
  ) {}

  async chat(request: ModelRequest): Promise<ModelResponse> {
    this.instrumentation.recordModelCall(request.model)
    return this.delegate.chat(request)
  }
}

export function createCountingFetch(
  fetcher: typeof fetch,
  onRequest: () => void,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    onRequest()
    return fetcher(input, init)
  }) as typeof fetch
}
