import type { ModelClient } from '../llm/modelClient.js'
import { caseSnapshotId, bindGeneratedQuestions } from '../case/caseSnapshot.js'
import type { ModelRouter } from '../llm/modelRouter.js'
import { parseModelJson } from '../llm/modelJson.js'
import { collectKnownFactIds, filterKnownFactReferences } from '../classification/disputeIdentifier.js'
import { LegalQuestionError, assertNoLegalConclusion } from './legalQuestionError.js'
import { buildLegalQuestionMessages } from './legalQuestionPrompt.js'
import { assessReliefCoverage, isSubstantiveReliefQuestion } from './reliefCoverage.js'
import {
  legalQuestionResponseSchema,
  type LegalQuestion,
  type LegalQuestionSource,
} from './legalQuestionSchema.js'

export interface LegalQuestionDecomposer {
  decompose(source: LegalQuestionSource): Promise<LegalQuestion[]>
}

export class ModelLegalQuestionDecomposer implements LegalQuestionDecomposer {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly modelRouter: ModelRouter,
    private readonly createId: (index: number) => string = (index) => `question-${index + 1}`,
  ) {}

  async decompose(source: LegalQuestionSource): Promise<LegalQuestion[]> {
    const snapshot = caseSnapshotId(source.case)
    if (source.classification.caseId !== source.case.id || source.disputeAnalysis.caseId !== source.case.id) {
      throw new LegalQuestionError('INVALID_INPUT', 'Legal question input mixes different cases')
    }

    const issueIds = new Set(source.disputeAnalysis.issues.map((issue) => issue.id))
    if (issueIds.size !== source.disputeAnalysis.issues.length) {
      throw new LegalQuestionError('INVALID_INPUT', 'Legal question input contains duplicate issue IDs')
    }
    if (issueIds.size === 0) {
      return []
    }

    const response = await this.modelClient.chat({
      model: this.modelRouter.getModel('FLASH'),
      messages: buildLegalQuestionMessages(source),
      temperature: 0,
    })

    let parsed: unknown
    try {
      parsed = parseModelJson(response.text)
    } catch (error) {
      throw new LegalQuestionError('INVALID_RESPONSE', 'Legal question model returned invalid JSON', {
        cause: error,
      })
    }

    const result = legalQuestionResponseSchema.safeParse(parsed)
    if (!result.success) {
      throw new LegalQuestionError('INVALID_RESPONSE', 'Legal question output failed schema validation', {
        cause: result.error,
      })
    }

    const knownFactIds = collectKnownFactIds(source.case)
    const issueById = new Map(source.disputeAnalysis.issues.map(issue => [issue.id, issue]))
    const unknownFactKeys = new Set(source.case.unknownFacts.map(item => factQuestionKey(item.question)))
    const questions: LegalQuestion[] = []
    const seenQuestions = new Set<string>()

    for (const draft of result.data.questions) {
      assertNoLegalConclusion(draft.question, 'question')

      // 模型伪造的 issueId 一律丢弃，不允许进入后续流程。
      if (!issueIds.has(draft.issueId)) {
        continue
      }

      const relatedFactIds = filterKnownFactReferences(draft.relatedFactIds, knownFactIds)
      const issue = issueById.get(draft.issueId)!
      const issueComesFromUnknownFact = unknownFactKeys.has(factQuestionKey(issue.question))
      const draftIsOnlyFactQuestion = unknownFactKeys.has(factQuestionKey(draft.question))
        && relatedFactIds.length === 0 && draft.questionType === 'OTHER'
      if (draftIsOnlyFactQuestion) continue
      if ((issueComesFromUnknownFact || isFactGatheringQuestion(issue.question))
        && !hasIndependentLegalIssue(draft.question)) continue
      const questionKey = `${draft.issueId}\u0000${normalizeQuestionText(draft.question)}`
      if (seenQuestions.has(questionKey)) continue
      seenQuestions.add(questionKey)

      questions.push({
        id: this.createId(questions.length),
        question: draft.question,
        issueId: draft.issueId,
        importance: draft.importance === 'HIGH' && issueComesFromUnknownFact && relatedFactIds.length === 0
          ? 'MEDIUM' : draft.importance,
        questionType: draft.questionType,
        relatedFactIds,
      })
    }

    const reliefCoverage = assessReliefCoverage(source.rawCase, source.case, questions)
    if (reliefCoverage.some(item => item.status === 'MISSING')) {
      throw new LegalQuestionError('INVALID_RESPONSE', 'MISSING_RELIEF_COVERAGE', { reliefCoverage })
    }
    return bindGeneratedQuestions(source.case, questions, snapshot)
  }
}

function normalizeQuestionText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ')
    .replace(/，/gu, ',').replace(/。/gu, '.').replace(/；/gu, ';')
    .replace(/：/gu, ':').replace(/？/gu, '?').replace(/！/gu, '!')
}

function factQuestionKey(text: string): string {
  return text.normalize('NFC').replace(/[\s，,。；;：:？?]/gu, '')
    .replace(/^(?:请问|需要确认)/u, '').replace(/(?:是什么|有哪些)$/u, '')
}

function isFactGatheringQuestion(question: string): boolean {
  return /(?:具体|何时|何种|有无|是什么|是否(?:已|曾|存在|签订|支付|使用|提供|拒绝))/.test(question)
    && /(?:身份|名称|时间|日期|内容|条件|原因|方式|凭证|合同|付款|服务|返还|营业)/.test(question)
}

function hasIndependentLegalIssue(question: string): boolean {
  if (/(?:借款|借贷)(?:关系|合同).{0,8}成立|电子(?:数据|证据)|(?:聊天|转账).*(?:真实性|证明力)/.test(question)) return true
  if (/(?:明确被告|适格被告|诉讼主体|起诉条件|起诉.*(?:身份|主体|信息)|(?:身份|主体).*起诉)/.test(question)) return true
  return /(?:举证责任|证明责任|合同(?:成立|效力|解除|履行)|解除权|违约|赔偿|诉讼时效|法律适用|权利|义务|效力|返还范围|退款范围|返还义务|退款义务)/.test(question)
    || isSubstantiveReliefQuestion(question)
}
