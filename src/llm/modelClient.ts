import { DEFAULT_MODEL_TIMEOUT_MS, isAllowedModelBaseURL, type ModelConfig } from '../config/modelConfig.js'
import { createHash } from 'node:crypto'
import type { ProviderFailureDiagnostic } from '../integration/failureDiagnostic.js'

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelRequest {
  model: string
  messages: ModelMessage[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  retryOnTimeout?: boolean
  reasoningEffort?: 'none' | 'low' | 'high' | 'max'
  diagnosticContext?: { stage: 'ENTAILMENT'; targetIds: string[] }
}

export interface ModelResponse {
  text: string
  model: string
  finishReason?: SafeFinishReason
  responseMetadata?: NonNullable<Extract<ProviderFailureDiagnostic, { failureKind: 'PROVIDER_RESPONSE' }>['responseMetadata']>
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    promptCacheHitTokens?: number
    promptCacheMissTokens?: number
  }
}

export interface ModelClient {
  chat(request: ModelRequest): Promise<ModelResponse>
}

export type ModelClientErrorCode =
  | 'CONFIG_ERROR'
  | 'AUTH_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RATE_LIMIT'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE'

export class ModelClientError extends Error {
  readonly diagnostic?: ProviderFailureDiagnostic
  constructor(
    public readonly code: ModelClientErrorCode,
    message: string,
    options?: ErrorOptions & { diagnostic?: ProviderFailureDiagnostic },
  ) {
    super(message, options)
    this.name = 'ModelClientError'
    this.diagnostic = options?.diagnostic
  }
}

type FetchLike = typeof fetch
export const MAX_MODEL_RESPONSE_BYTES = 2_000_000

interface OpenAIResponse {
  model?: unknown
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown } }>
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
    completion_tokens_details?: { reasoning_tokens?: unknown }
    prompt_cache_hit_tokens?: unknown
    prompt_cache_miss_tokens?: unknown
  }
}

export class OpenAICompatibleModelClient implements ModelClient {
  private readonly fetcher: FetchLike
  private readonly timeoutMs: number
  private readonly onResponse?: (body: string, request: ModelRequest) => void

  constructor(
    private readonly config: Pick<ModelConfig, 'apiKey' | 'baseURL'> & Partial<Pick<ModelConfig, 'timeoutMs'>>,
    options: { fetch?: FetchLike; timeoutMs?: number; onResponse?: (body: string, request: ModelRequest) => void } = {},
  ) {
    if (!config.apiKey.trim() || !config.baseURL.trim()) {
      throw new ModelClientError('CONFIG_ERROR', 'Model client requires API key and base URL')
    }

    if (!isAllowedModelBaseURL(config.baseURL)) {
      throw new ModelClientError('CONFIG_ERROR', 'Model client base URL must use HTTPS, except HTTP loopback for local development')
    }

    this.fetcher = options.fetch ?? fetch
    this.onResponse = options.onResponse
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new ModelClientError('CONFIG_ERROR', 'Model timeoutMs must be an integer between 1 and 2147483647')
    }
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    if (request.reasoningEffort !== undefined && !['none', 'low', 'high', 'max'].includes(request.reasoningEffort)) {
      throw new ModelClientError('CONFIG_ERROR', 'Unsupported reasoning effort')
    }
    try {
      return await this.chatAttempt(request, 1)
    } catch (error) {
      if (!(error instanceof ModelClientError) || error.code !== 'TIMEOUT' || request.retryOnTimeout === false) throw error
    }
    // Only an internally triggered deadline can retry, and only once.
    return this.chatAttempt(request, 2)
  }

  private async chatAttempt(request: ModelRequest, attempt: 1 | 2): Promise<ModelResponse> {
    if (request.signal?.aborted) {
      throw new ModelClientError('CANCELLED', 'Model request cancelled')
    }
    const started = performance.now()
    let phase: 'FETCH' | 'READ_RESPONSE' | 'VALIDATE_RESPONSE' = 'FETCH'
    let httpStatus: number | undefined
    let jsonParsed = false
    const controller = new AbortController()
    let abortError: ModelClientError | undefined
    let rejectAbort!: (error: ModelClientError) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const abort = (code: 'TIMEOUT' | 'CANCELLED') => {
      if (abortError) return
      abortError = new ModelClientError(code, code === 'TIMEOUT'
        ? `Model request timed out after ${this.timeoutMs}ms`
        : 'Model request cancelled', { diagnostic: { failureKind: 'PROVIDER_TRANSPORT', phase,
          responseReceived: httpStatus !== undefined, ...(httpStatus === undefined ? {} : { httpStatus }),
          jsonParsed, attempt, durationMs: performance.now() - started, errorType: 'DOMException', networkCode: 'UNKNOWN' } })
      rejectAbort(abortError)
      controller.abort()
    }
    const forwardAbort = () => abort('CANCELLED')
    request.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => abort('TIMEOUT'), this.timeoutMs)

    try {
      const response = await Promise.race([aborted, this.fetcher(`${this.config.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(request.reasoningEffort === 'none' && new URL(this.config.baseURL).hostname === 'api.deepseek.com'
            ? { thinking: { type: 'disabled' } }
            : request.reasoningEffort !== undefined ? { reasoning_effort: request.reasoningEffort } : {}),
        }),
        signal: controller.signal,
      }).then(response => {
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {})
          controller.signal.throwIfAborted()
        }
        return response
      })])

      httpStatus = response.status
      phase = 'READ_RESPONSE'
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        const diagnostic: ProviderFailureDiagnostic = { failureKind: 'PROVIDER_HTTP', httpStatus: response.status }
        if (response.status === 401 || response.status === 403) {
          throw new ModelClientError('AUTH_ERROR', 'Model provider rejected authentication', { diagnostic })
        }
        if (response.status === 429) {
          throw new ModelClientError('RATE_LIMIT', 'Model provider rate limit exceeded', { diagnostic })
        }
        throw new ModelClientError('UPSTREAM_ERROR', `Model provider returned HTTP ${response.status}`, { diagnostic })
      }

      let payload: OpenAIResponse
      try {
        payload = (await Promise.race([aborted, readJsonResponse(response, controller.signal, body => this.onResponse?.(body, request))])) as OpenAIResponse
      } catch (error) {
        if (abortError) throw abortError
        if (error instanceof ModelClientError) throw error
        if (!(error instanceof SyntaxError)) throw error
        throw new ModelClientError('INVALID_RESPONSE', 'Model provider returned invalid JSON', {
          cause: error, diagnostic: { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'INVALID_JSON' },
        })
      }

      jsonParsed = true
      phase = 'VALIDATE_RESPONSE'
      const responseMetadata = safeResponseMetadata(payload, !!request.diagnosticContext)
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices)
        || payload.choices.length === 0 || !payload.choices[0]?.message
        || typeof payload.choices[0].message !== 'object') {
        throw new ModelClientError('INVALID_RESPONSE', 'Model provider response structure is incompatible', {
          diagnostic: { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'INVALID_STRUCTURE', responseMetadata },
        })
      }
      const text = payload.choices[0].message.content
      if (typeof text !== 'string' || !text.trim()) {
        const responseIssue = responseMetadata.finishReason === 'LENGTH'
          ? 'OUTPUT_LIMIT_NO_CONTENT'
          : text === undefined || text === null || typeof text === 'string'
            ? 'EMPTY_CONTENT' : 'UNSUPPORTED_CONTENT_TYPE'
        throw new ModelClientError('INVALID_RESPONSE', 'Model provider response has no usable message content', {
          diagnostic: { failureKind: 'PROVIDER_RESPONSE', responseIssue, responseMetadata },
        })
      }

      return {
        text,
        model: typeof payload.model === 'string' ? payload.model : request.model,
        ...(responseMetadata.finishReason === 'MISSING' ? {} : { finishReason: responseMetadata.finishReason }),
        ...(request.diagnosticContext ? { responseMetadata } : {}),
        usage: payload.usage
          ? {
              promptTokens: asNonnegativeInteger(payload.usage.prompt_tokens),
              completionTokens: asNonnegativeInteger(payload.usage.completion_tokens),
              totalTokens: asNonnegativeInteger(payload.usage.total_tokens),
              ...optionalUsageDetails(payload.usage),
            }
          : undefined,
      }
    } catch (error) {
      if (abortError) throw abortError
      if (error instanceof ModelClientError) {
        if (request.diagnosticContext && error.diagnostic) throw new ModelClientError(error.code, error.message, {
          cause: error, diagnostic: { ...error.diagnostic, requestMetadata: { ...request.diagnosticContext,
            model: request.model, maxTokens: request.maxTokens!, ...(request.temperature === undefined ? {} : { temperature: request.temperature }) } },
        })
        throw error
      }
      throw new ModelClientError('UPSTREAM_ERROR', 'Model request failed', { cause: error, diagnostic: {
        failureKind: 'PROVIDER_TRANSPORT', phase, responseReceived: httpStatus !== undefined,
        ...(httpStatus === undefined ? {} : { httpStatus }), jsonParsed, attempt,
        durationMs: performance.now() - started,
        errorType: error instanceof DOMException ? 'DOMException' : error instanceof TypeError ? 'TypeError'
          : error instanceof Error ? 'Error' : 'OTHER',
        networkCode: safeNetworkCode(error),
      } })
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}

type SafeFinishReason = 'STOP' | 'LENGTH' | 'CONTENT_FILTER' | 'TOOL_CALLS' | 'FUNCTION_CALL'
  | 'INSUFFICIENT_SYSTEM_RESOURCE' | 'OTHER'

/** Only literal allowlisted codes, at most four cause levels. Never inspect messages/URLs. */
function safeResponseMetadata(payload: unknown, includeDetails = false): NonNullable<Extract<ProviderFailureDiagnostic,
  { failureKind: 'PROVIDER_RESPONSE' }>['responseMetadata']> {
  const root = payload && typeof payload === 'object' ? payload as OpenAIResponse : undefined
  const choices = Array.isArray(root?.choices) ? root.choices : []
  const first = choices[0]
  const message = first?.message && typeof first.message === 'object' ? first.message : undefined
  const content = message?.content
  const promptTokens = asNonnegativeInteger(root?.usage?.prompt_tokens)
  const completionTokens = asNonnegativeInteger(root?.usage?.completion_tokens)
  const totalTokens = asNonnegativeInteger(root?.usage?.total_tokens)
  const details = optionalUsageDetails(root?.usage)
  const usage = promptTokens === undefined && completionTokens === undefined && totalTokens === undefined && !Object.keys(details).length ? undefined : {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...details,
  }
  let finalAnswerJsonParsed = false
  if (includeDetails && typeof content === 'string' && content.trim()) { try { JSON.parse(content); finalAnswerJsonParsed = true } catch { /* syntax only, never a semantic verdict */ } }
  return {
    choiceCount: Math.min(choices.length, 1000),
    messagePresent: message !== undefined,
    contentKind: content === undefined ? 'MISSING' : content === null ? 'NULL'
      : typeof content === 'string' ? 'STRING' : Array.isArray(content) ? 'ARRAY' : 'OTHER',
    finishReason: safeFinishReason(first?.finish_reason),
    reasoningContentPresent: typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0,
    ...(includeDetails ? { finalAnswerPresent: typeof content === 'string' && !!content.trim(), finalAnswerJsonParsed,
      contentCharacters: typeof content === 'string' ? content.length : 0,
      reasoningCharacters: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0,
      ...(typeof content === 'string' ? { contentHash: createHash('sha256').update(content).digest('hex') } : {}) } : {}),
    ...(usage ? { usage } : {}),
  }
}

function optionalUsageDetails(usage: OpenAIResponse['usage']) {
  const values = { reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    promptCacheHitTokens: usage?.prompt_cache_hit_tokens, promptCacheMissTokens: usage?.prompt_cache_miss_tokens }
  return Object.fromEntries(Object.entries(values).filter(([, v]) => asNonnegativeInteger(v) !== undefined)) as Partial<NonNullable<ModelResponse['usage']>>
}

function safeFinishReason(value: unknown): SafeFinishReason | 'MISSING' {
  switch (value) {
    case 'stop': return 'STOP'
    case 'length': return 'LENGTH'
    case 'content_filter': return 'CONTENT_FILTER'
    case 'tool_calls': return 'TOOL_CALLS'
    case 'function_call': return 'FUNCTION_CALL'
    case 'insufficient_system_resource': return 'INSUFFICIENT_SYSTEM_RESOURCE'
    case undefined: case null: return 'MISSING'
    default: return 'OTHER'
  }
}

function safeNetworkCode(error: unknown): Extract<ProviderFailureDiagnostic, { failureKind: 'PROVIDER_TRANSPORT' }>['networkCode'] {
  let current = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    // Data descriptors avoid invoking arbitrary error property getters.
    const code: unknown = Object.getOwnPropertyDescriptor(current, 'code')?.value
    switch (code) {
      case 'ENOTFOUND': case 'EAI_AGAIN': case 'ECONNREFUSED': case 'ECONNRESET': case 'ETIMEDOUT':
      case 'UND_ERR_CONNECT_TIMEOUT': case 'UND_ERR_HEADERS_TIMEOUT': case 'UND_ERR_BODY_TIMEOUT': case 'UND_ERR_SOCKET':
      case 'CERT_HAS_EXPIRED': case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN':
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': case 'ERR_TLS_CERT_ALTNAME_INVALID':
        return code
    }
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value
  }
  return 'UNKNOWN'
}

async function readJsonResponse(response: Response, signal: AbortSignal, onBody?: (body: string) => void): Promise<unknown> {
  signal.throwIfAborted()
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_MODEL_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {})
    throw new ModelClientError('INVALID_RESPONSE', `Model provider response exceeds ${MAX_MODEL_RESPONSE_BYTES} bytes`, {
      diagnostic: { failureKind: 'PROVIDER_RESPONSE', responseIssue: /^\d+$/.test(declared) ? 'RESPONSE_TOO_LARGE' : 'INVALID_CONTENT_LENGTH' },
    })
  }
  if (!response.body) throw new ModelClientError('INVALID_RESPONSE', 'Model provider response body is missing', {
    diagnostic: { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'MISSING_BODY' },
  })
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > MAX_MODEL_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {})
        throw new ModelClientError('INVALID_RESPONSE', `Model provider response exceeds ${MAX_MODEL_RESPONSE_BYTES} bytes`, {
          diagnostic: { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'RESPONSE_TOO_LARGE' },
        })
      }
      chunks.push(chunk.value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch (error) { throw new ModelClientError('INVALID_RESPONSE', 'Model provider response is not UTF-8', {
    cause: error, diagnostic: { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'INVALID_UTF8' },
  }) }
  signal.throwIfAborted()
  onBody?.(text) // Opt-in controlled acceptance only; cancelled bodies never persist as completed responses.
  return JSON.parse(text) as unknown
}

function asNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
