import { caseSchema, type Case } from '../case/caseSchema.js'
import type { ModelClient, ModelRouter } from '../llm/index.js'
import { parseModelJson } from '../llm/modelJson.js'
import { buildFactExtractionMessages } from './factExtractionPrompt.js'

export const MAX_CASE_INPUT_CHARS = 20_000

export interface FactExtractor {
  extract(input: string): Promise<Case>
}

export type FactExtractionErrorCode = 'INVALID_INPUT' | 'INVALID_RESPONSE'

export class FactExtractionError extends Error {
  constructor(public readonly code: FactExtractionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FactExtractionError'
  }
}

export class ModelFactExtractor implements FactExtractor {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly modelRouter: ModelRouter,
    private readonly createId: () => string = () => `case-${Date.now()}`,
  ) {}

  async extract(input: string): Promise<Case> {
    if (!input.trim()) {
      throw new FactExtractionError('INVALID_INPUT', 'Case description must not be empty')
    }
    if (input.length > MAX_CASE_INPUT_CHARS) {
      throw new FactExtractionError('INVALID_INPUT', `Case description must not exceed ${MAX_CASE_INPUT_CHARS} characters`)
    }

    const response = await this.modelClient.chat({
      model: this.modelRouter.getModel('FLASH'),
      messages: buildFactExtractionMessages(input),
      temperature: 0,
    })

    try {
      const parsed = parseModelJson(response.text)
      return caseSchema.parse({ ...parsed as object, id: this.createId() })
    } catch (error) {
      throw new FactExtractionError('INVALID_RESPONSE', 'Fact extraction model returned invalid Case JSON', {
        cause: error,
      })
    }
  }
}
