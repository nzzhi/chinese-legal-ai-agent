import type { Case } from '../case/caseSchema.js'
import type { ModelClient } from '../llm/modelClient.js'
import type { ModelRouter } from '../llm/modelRouter.js'
import { parseModelJson } from '../llm/modelJson.js'
import { ClassificationError, assertNoLegalCitation } from './classificationError.js'
import { buildCaseClassificationMessages } from './classificationPrompt.js'
import { caseClassificationSchema, type ClassificationResult } from './classificationSchema.js'

export interface CaseClassifier {
  classify(caseInput: Case): Promise<ClassificationResult>
}

export class ModelCaseClassifier implements CaseClassifier {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly modelRouter: ModelRouter,
  ) {}

  async classify(caseInput: Case): Promise<ClassificationResult> {
    const response = await this.modelClient.chat({
      model: this.modelRouter.getModel('FLASH'),
      messages: buildCaseClassificationMessages(caseInput),
      temperature: 0,
    })

    let parsed: unknown
    try {
      parsed = parseModelJson(response.text)
    } catch (error) {
      throw new ClassificationError('INVALID_RESPONSE', 'Case classification model returned invalid JSON', {
        cause: error,
      })
    }

    const result = caseClassificationSchema.safeParse(parsed)
    if (!result.success) {
      throw new ClassificationError('INVALID_RESPONSE', 'Case classification failed schema validation', {
        cause: result.error,
      })
    }

    assertNoLegalCitation(result.data.reason, 'classification.reason')

    return { caseId: caseInput.id, classification: result.data }
  }
}
