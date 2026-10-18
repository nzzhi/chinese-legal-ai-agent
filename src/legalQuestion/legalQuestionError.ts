import { legalCitationPattern } from '../classification/classificationError.js'
import type { ReliefCoverage } from './reliefCoverage.js'

export type LegalQuestionErrorCode = 'INVALID_INPUT' | 'INVALID_RESPONSE'

export class LegalQuestionError extends Error {
  readonly reliefCoverage?: ReliefCoverage[]
  constructor(
    public readonly code: LegalQuestionErrorCode,
    message: string,
    options?: ErrorOptions & { reliefCoverage?: ReliefCoverage[] },
  ) {
    super(message, options)
    this.name = 'LegalQuestionError'
    this.reliefCoverage = options?.reliefCoverage
  }
}

/** 胜诉预测类表述，无论句式一律视为非法。 */
const winPredictionPattern =
  /胜诉概率|败诉概率|胜诉可能|败诉可能|胜诉率|败诉率|稳赢|大概率支持|大概率会支持|能不能赢|能否赢|赢面/

/** 结论式表述：出现在非疑问分句中即视为法律结论泄漏。 */
const conclusionPattern =
  /属于无效|属于有效|系无效|系有效|条款无效|条款有效|合同无效|合同有效|应当退款|应当退还|应当返还|应当赔偿|应当获得|应当得到|必须退款|必须退还|必须返还|必须赔偿|构成违约|已经违约|有权解除|有权要求|有权获得|一定可以|一定能够|明显违法|属于欺诈|可以胜诉/

const questionMarkerPattern = /[?？]|是否|能否|可否|如何|为何|哪些|多少|什么|怎样|吗|有无/

/**
 * 输出中不允许出现的内容类型。
 * Step 6 复用该检测，避免出现第二套规则。
 */
export type OutputViolation = 'LEGAL_CITATION' | 'WIN_PREDICTION' | 'LEGAL_CONCLUSION'

const violationLabels: Record<OutputViolation, string> = {
  LEGAL_CITATION: 'a legal citation',
  WIN_PREDICTION: 'a win prediction',
  LEGAL_CONCLUSION: 'a legal conclusion',
}

/**
 * 简单、可解释的输出安全检查：
 * 1. 不得出现具体法律条文引用。
 * 2. 不得出现胜诉/败诉预测。
 * 3. 逐分句检查，若某分句包含结论式表述且该分句不含疑问标记，则判定为结论泄漏。
 */
export function detectOutputViolation(text: string): OutputViolation | undefined {
  if (legalCitationPattern.test(text)) {
    return 'LEGAL_CITATION'
  }

  if (winPredictionPattern.test(text)) {
    return 'WIN_PREDICTION'
  }

  for (const clause of text.split(/[，,。；;]/)) {
    if (conclusionPattern.test(clause) && !questionMarkerPattern.test(clause)) {
      return 'LEGAL_CONCLUSION'
    }
  }

  return undefined
}

export function assertNoLegalConclusion(text: string, field: string): void {
  const violation = detectOutputViolation(text)
  if (violation === undefined) {
    return
  }

  throw new LegalQuestionError(
    'INVALID_RESPONSE',
    `Step 5 output for ${field} must not contain ${violationLabels[violation]}`,
  )
}
