export type ClassificationErrorCode = 'INVALID_INPUT' | 'INVALID_RESPONSE'

export class ClassificationError extends Error {
  constructor(
    public readonly code: ClassificationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ClassificationError'
  }
}

export const legalCitationPattern =
  /《[^》]*(法|法规|条例|规定|解释|办法|规则)[^》]*》\s*第[一二三四五六七八九十百千零两\d]+条/

export function assertNoLegalCitation(text: string, field: string): void {
  if (legalCitationPattern.test(text)) {
    throw new ClassificationError(
      'INVALID_RESPONSE',
      `Step 4 output for ${field} must not contain a legal citation`,
    )
  }
}
