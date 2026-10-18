export type RetrievalErrorCode = 'INVALID_INPUT' | 'INVALID_RESPONSE' | 'PROVIDER_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR' | 'HTTP_SERVER_ERROR' | 'ACCESS_RESTRICTED'

export class RetrievalError extends Error {
  constructor(
    public readonly code: RetrievalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RetrievalError'
  }
}

/** Unknown exceptions remain fatal; only recognized transport errors degrade. */
export function classifyProviderError(error: unknown): RetrievalError {
  if (error instanceof RetrievalError) return error
  const visited = new Set<unknown>()
  let current = error
  let networkType: string | undefined
  const messages: string[] = []
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    messages.push(current.message)
    const code = 'code' in current ? current.code : undefined
    if (typeof code === 'string' && [
      'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
      'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    ].includes(code)) networkType = code
    current = current.cause
  }
  if (networkType || (error instanceof TypeError && error.message === 'fetch failed')) {
    return new RetrievalError('NETWORK_ERROR', `${networkType ?? 'fetch failed'}: ${messages.join(': ')}`, { cause: error })
  }
  return new RetrievalError('PROVIDER_ERROR', 'Retrieval provider failed', { cause: error })
}

export function isRecoverableRetrievalError(error: unknown): error is RetrievalError {
  return error instanceof RetrievalError && ['NETWORK_ERROR', 'HTTP_SERVER_ERROR', 'TIMEOUT', 'ACCESS_RESTRICTED'].includes(error.code)
}

