import type { Case } from '../case/caseSchema.js'
import type { LegalQuestion } from './legalQuestionSchema.js'

const actions = [
  { kind: 'RETURN_GOODS', words: /退货|返还(?:商品|货物)/u },
  { kind: 'RETURN_MONEY', words: /退款|退费|退钱|退还|退回|返还/u },
  { kind: 'PAY', words: /支付|给付|偿还|清偿/u },
  { kind: 'COMPENSATE', words: /赔偿|补偿/u },
  { kind: 'TERMINATE', words: /解除|终止/u },
  { kind: 'PERFORM', words: /继续履行|履行/u },
  { kind: 'CEASE', words: /停止侵害|停止侵权|停止侵犯/u },
] as const

export type ReliefAction = typeof actions[number]['kind']
export interface ReliefCoverage {
  reliefId: string
  action: ReliefAction
  requestText: string
  relatedFactIds: string[]
  status: 'COVERED' | 'MISSING'
  legalQuestionIds: string[]
}

const requestMarker = /要求|请求|主张|希望|诉请|想要|我要|我想/u
const legalFrame = /法律依据|条件|后果|权利|义务|责任|效力|范围|能否|可否|是否可以|应否|应当/u
const procedureOnly = /举证|证明责任|证据|材料|程序|诉讼/u

export function isSubstantiveReliefQuestion(question: string): boolean {
  return legalFrame.test(question) && !procedureOnly.test(question)
    && !/有何(?:法律)?影响/u.test(question)
    && actions.some(action => action.words.test(question))
}

function objectMatches(object: string, question: string): boolean {
  if (/\d+\s*元/u.test(object) && /款|费|金额|元/u.test(question)) return true
  const normalized = object.replace(/[\s\d０-９元的该其全部剩余未已部分]/gu, '')
  if (!normalized) return true
  if (question.includes(normalized)) return true
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(normalized)]
    .map(item => item.segment).filter(word => /^[\p{Script=Han}]{2,}$/u.test(word))
  return words.some(word => question.includes(word))
}

function contextMatches(caseData: Case, requestFactIds: string[], question: LegalQuestion): boolean {
  return [...caseData.facts, ...caseData.disputedFacts].some(fact => !requestFactIds.includes(fact.id)
    && question.relatedFactIds.includes(fact.id)
    && [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(fact.content)]
      .map(item => item.segment)
      .filter(word => /^[\p{Script=Han}]{2,}$/u.test(word)
        && !/^(?:用户|消费者|商家|对方|卖方|买方|本人)$/u.test(word))
      .some(word => question.question.includes(word)))
}

/** Only an explicit request in the original case text can create a relief. */
export function assessReliefCoverage(rawCase: string | undefined, caseData: Case,
  questions: LegalQuestion[]): ReliefCoverage[] {
  if (!rawCase) return [] // Legacy direct callers did not supply the original case text.
  const reliefs: ReliefCoverage[] = []
  const seen = new Set<string>()
  for (const clause of rawCase.split(/[。；;！!，,]/u)) {
    const marker = requestMarker.exec(clause)
    if (!marker) continue
    const subject = clause.slice(0, marker.index)
    if (/(?:商家|对方|被告|债务人|经营者)/u.test(subject)
      && !/(?:用户|消费者|我方|本人|原告|债权人)/u.test(subject)) continue
    const request = clause.slice(marker.index + marker[0].length).trim()
    for (const action of actions) {
      const match = action.words.exec(request)
      if (!match) continue
      if (action.kind === 'RETURN_MONEY' && /^(?:商品|货物)/u.test(request.slice(match.index + match[0].length))) continue
      const object = request.slice(match.index + match[0].length).split(/并|且|以及|同时/u)[0].trim()
      const key = `${action.kind}\u0000${object}`
      if (seen.has(key)) continue
      seen.add(key)
      const relatedFactIds = [...caseData.facts, ...caseData.disputedFacts]
        .filter(fact => action.words.test(fact.content)
          && requestMarker.test(fact.content)
          && (!object || objectMatches(object, fact.content)))
        .map(fact => fact.id)
      const legalQuestionIds = questions.filter(question => question.questionType !== 'PROCEDURE'
        && action.words.test(question.question)
        && isSubstantiveReliefQuestion(question.question)
        && (!object || objectMatches(object, question.question))
        && relatedFactIds.some(id => question.relatedFactIds.includes(id))
        && contextMatches(caseData, relatedFactIds, question))
        .map(question => question.id)
      reliefs.push({ reliefId: `relief-${reliefs.length + 1}`, action: action.kind,
        requestText: request.slice(match.index, match.index + match[0].length + object.length),
        relatedFactIds, status: legalQuestionIds.length ? 'COVERED' : 'MISSING', legalQuestionIds })
    }
  }
  return reliefs
}
