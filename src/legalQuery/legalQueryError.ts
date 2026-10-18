import { detectOutputViolation, type OutputViolation } from '../legalQuestion/legalQuestionError.js'
import type { QueryFailureDiagnostic } from '../integration/failureDiagnostic.js'

export type LegalQueryErrorCode = 'INVALID_INPUT' | 'INVALID_RESPONSE'

export class LegalQueryError extends Error {
  readonly diagnostic?: QueryFailureDiagnostic
  constructor(
    public readonly code: LegalQueryErrorCode,
    message: string,
    options?: ErrorOptions & { diagnostic?: QueryFailureDiagnostic },
  ) {
    super(message, options)
    this.name = 'LegalQueryError'
    this.diagnostic = options?.diagnostic
  }
}

const violationLabels: Record<OutputViolation, string> = {
  LEGAL_CITATION: 'a legal citation',
  WIN_PREDICTION: 'a win prediction',
  LEGAL_CONCLUSION: 'a legal conclusion',
}

/** Compare complete numeric/unit tokens, not numeric substrings (800 is not 4800). */
const factPattern = /(\d[\d,.]*)\s*(元|万元|次|年|月|日)/g

type QueryField = Extract<QueryFailureDiagnostic, { failureKind: 'QUERY_BUSINESS_RULE' }>['field']

export function queryRuleDiagnostic(
  ruleId: Extract<QueryFailureDiagnostic, { failureKind: 'QUERY_BUSINESS_RULE' }>['ruleId'],
  field: QueryField, legalQuestionId?: string,
  context?: Pick<Extract<QueryFailureDiagnostic, { failureKind: 'QUERY_BUSINESS_RULE' }>,
    'legalQuestionText' | 'rawQueryDraft' | 'formulatedQuery' | 'detectedDomainAnchors' | 'detectedDisputeAnchors' | 'domainDiagnostic'>,
): QueryFailureDiagnostic {
  return { failureKind: 'QUERY_BUSINESS_RULE', ruleId, field, coverageStatus: 'REJECTED',
    // Only program-generated IDs are safe to persist; arbitrary caller IDs may contain case text.
    legalQuestionId: legalQuestionId && /^question-[1-9]\d{0,9}$/.test(legalQuestionId) ? legalQuestionId : undefined,
    ...(context ? { ...context, rejectionRuleId: ruleId } : {}),
  }
}

/**
 * 简单、可解释的输出安全检查：
 * 1. 复用 Step 5 的检测，禁止法律条文、胜诉预测、法律结论泄漏。
 * 2. 禁止引入输入 LegalQuestion 中不存在的金额、日期、次数。
 */
export function assertQueryTextSafe(text: string, field: QueryField, allowedFactText: string, legalQuestionId?: string): void {
  const violation = detectOutputViolation(text)
  if (violation !== undefined) {
    throw new LegalQueryError(
      'INVALID_RESPONSE',
      `Step 6 output for ${field} must not contain ${violationLabels[violation]}`,
      { diagnostic: queryRuleDiagnostic(violation, field, legalQuestionId) },
    )
  }

  const allowedFacts = new Set([...allowedFactText.matchAll(factPattern)].map(match => match[0].replace(/\s/g, '')))
  for (const match of text.matchAll(factPattern)) {
    if (!allowedFacts.has(match[0].replace(/\s/g, ''))) {
      throw new LegalQueryError(
        'INVALID_RESPONSE',
        `Step 6 output for ${field} must not introduce facts that are absent from the input LegalQuestion`,
        { diagnostic: queryRuleDiagnostic('UNGROUNDED_FACT', field, legalQuestionId) },
      )
    }
  }
}
