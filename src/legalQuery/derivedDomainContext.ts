import type { LegalQuestion, LegalQuestionType } from '../legalQuestion/legalQuestionSchema.js'
import {
  disputeAnchors, groundedFallbackExpressions, legalDomainAnchors, legalRelationshipAnchors,
  type PrimaryQueryAnchors,
  canonicalizeQueryFormulation, formulatePrimaryQueryWithAnchors,
} from './fallbackGrounding.js'
import type { SearchIntent } from './legalQuerySchema.js'

export type LegalDomainAnchor = Readonly<{ canonical: string; aliases: readonly string[] }>
// Query-only equivalence classes. Shared Authority/Gate vocabulary is deliberately unchanged.
const domainFamilies: readonly LegalDomainAnchor[] = [
  { canonical: '民间借贷', aliases: ['民间借贷', '借贷关系', '自然人之间借款', '自然人借款', '借款合同', '借款'] },
  { canonical: '预付式消费', aliases: ['预付式消费', '预付消费', '预付款消费', '预付式服务', '预付费服务', '预付费', '预付卡'] },
]
function normalizedDomains(text: string, lexical: readonly string[]): readonly LegalDomainAnchor[] {
  const ownPrepaidExpressions = [...text.matchAll(/预付(?:式|费|款)?[\p{Script=Han}]{0,6}(?:消费|服务|会员|课程)/gu)]
    .map(m => m[0]).filter(s => !/是否|能否|如何|应当|返还|退还|退款|退费|解除|终止|履行|支付|提供/.test(s))
  const families = domainFamilies.filter(f => f.aliases.some(a => text.includes(a))
    || f.canonical === '预付式消费' && ownPrepaidExpressions.length > 0)
    // A bank/financial loan must not be silently relabeled as private lending.
    .filter(f => f.canonical !== '民间借贷' || !/金融借款|银行|金融机构/.test(text) || text.includes('民间借贷'))
  const result = families.length ? families.map(f => ({ canonical: f.canonical,
    aliases: [...f.aliases, ...(f.canonical === '预付式消费' ? ownPrepaidExpressions : [])] }))
    : lexical.map(a => ({ canonical: a, aliases: [a] }))
  return Object.freeze(result.map(f => Object.freeze({ canonical: f.canonical, aliases: Object.freeze([...new Set(f.aliases)]) })))
}
const defendantIdentification = (text: string) => /被告|起诉对象/.test(text) && /确定|明确|识别|选择|应起诉/.test(text)

type QuestionSource = Readonly<{ kind: 'QUESTION'; id: string }>
type SourcedAnchor = Readonly<{ value: string; source: QuestionSource }>
type DomainDiagnostic = Readonly<{
  code: 'NO_DOMAIN_ANCHOR' | 'NO_DISPUTE_ANCHOR' | 'MONEY_LENDING_EXPRESSION'
  source: QuestionSource
  quote?: string
}>

/** A question-owned domain snapshot, not an adjudicated legal relationship. */
export type DerivedDomainContext = PrimaryQueryAnchors & Readonly<{
  questionId: string
  question: string
  questionType: LegalQuestionType
  recognitionStatus: 'RECOGNIZED' | 'UNRECOGNIZED'
  normalizedDomains: readonly LegalDomainAnchor[]
  anchorSources: Readonly<{
    relationshipAnchors: readonly SourcedAnchor[]
    domainAnchors: readonly SourcedAnchor[]
    disputeAnchors: readonly SourcedAnchor[]
  }>
  diagnostics: readonly DomainDiagnostic[]
}>

const money = '(?:\\d[\\d,，]*(?:\\.\\d+)?\\s*(?:万|千|百|亿)?(?:元|块(?:钱)?|美元|欧元|港元|日元)|[零〇一二两三四五六七八九十百千万亿]+(?:元|块(?:钱)?)|钱款|款项|资金|现金|人民币|美元|欧元|港币|(?<!没|有|缺|欠)钱(?!包|柜|箱|袋|夹|庄))'
const moneyLending = new RegExp(`(出借|借给)([^。；，,！？!?、\\n]{0,12}?)${money}|${money}(?:的(?:钱款|款项|资金|现金))?(?:全部|部分|都)?(出借|借给)`, 'gu')
const nonMoneyObject = /书(?!面)|车|房|账号|帐号|账户|设备|器材|电脑|手机|机器|工具|物品|钱包|钱柜|钱箱|钱袋|钱夹/u

function moneyLendingAnchors(question: string): Array<{ anchor: string; quote: string }> {
  const anchors: Array<{ anchor: string; quote: string }> = []
  // ponytail: bounded phrases; mixed objects are rejected instead of inferred across clauses.
  for (const clause of question.split(/(?<!\d)[,，]|[,，](?!\d)|[。；;！？!?、\n]/u)) {
    for (const match of clause.matchAll(moneyLending)) {
      const object = clause.slice(match.index).split(/(?:用于|用来|以便|为了)(?:购买|购置|租赁|支付)/u)[0]
      if (nonMoneyObject.test(object) || (match[1] && nonMoneyObject.test(clause.slice(Math.max(0, match.index - 12), match.index)))
        || /(?:价值|价格|售价)\s*$/u.test(clause.slice(0, match.index))
        || /价值|价格|售价|收到|收取|支付|租金|押金|费用/u.test(match[2] ?? '')) continue
      const anchor = match[1] ?? match[3]
      if (!anchors.some(item => item.anchor === anchor)) anchors.push({ anchor, quote: match[0] })
    }
  }
  return anchors
}

/** Existing lexical domains win; money-lending aliases stay within this question. */
export function deriveDomainContext(question: LegalQuestion): DerivedDomainContext {
  const source: QuestionSource = Object.freeze({ kind: 'QUESTION', id: question.id })
  const existingDomains = legalDomainAnchors(question.question)
  const moneyAnchors = existingDomains.length ? [] : moneyLendingAnchors(question.question)
  const relationships = Object.freeze([...legalRelationshipAnchors(question.question), ...moneyAnchors.map(item => item.anchor)])
  const domains = Object.freeze([...existingDomains, ...moneyAnchors.map(item => item.anchor)])
  const disputes = Object.freeze(disputeAnchors(question.question, question.questionType))
  const normalized = normalizedDomains(question.question, domains)
  const sourced = (anchors: readonly string[]) => Object.freeze(anchors.map(value => Object.freeze({ value, source })))
  const diagnostics: DomainDiagnostic[] = []
  for (const item of moneyAnchors) diagnostics.push(Object.freeze({ code: 'MONEY_LENDING_EXPRESSION', source, quote: item.quote }))
  if (!normalized.length) diagnostics.push(Object.freeze({ code: 'NO_DOMAIN_ANCHOR', source }))
  if (!disputes.length) diagnostics.push(Object.freeze({ code: 'NO_DISPUTE_ANCHOR', source }))
  return Object.freeze({
    questionId: question.id, question: question.question, questionType: question.questionType,
    relationshipAnchors: relationships, domainAnchors: domains, disputeAnchors: disputes,
    allowedFallbackExpressions: Object.freeze(groundedFallbackExpressions(question.question)),
    recognitionStatus: normalized.length ? 'RECOGNIZED' : 'UNRECOGNIZED', normalizedDomains: normalized,
    anchorSources: Object.freeze({
      relationshipAnchors: sourced(relationships), domainAnchors: sourced(domains), disputeAnchors: sourced(disputes),
    }),
    diagnostics: Object.freeze(diagnostics),
  })
}

export const hasContextDomainAnchor = (text: string, context: DerivedDomainContext) =>
  context.domainAnchors.some(anchor => text.includes(anchor))

export const hasContextDisputeAnchor = (text: string, context: DerivedDomainContext) =>
  context.disputeAnchors.some(anchor => text.includes(anchor))

/** Match aliases of the question-owned domain, never domains borrowed from another question. */
export function matchedPrimaryDomainAnchors(text: string, context: DerivedDomainContext): string[] {
  const normalized = text.normalize('NFKC').replace(/\s/gu, '')
  return [...new Set(context.normalizedDomains.flatMap(f => {
    if (f.canonical === '民间借贷' && /金融借款|银行|金融机构/.test(normalized) && !normalized.includes(f.canonical)) return []
    return f.aliases.filter(a => normalized.includes(a))
  }))]
}

export function validatePrimaryDomainQuery(text: string, context: DerivedDomainContext, importance: 'HIGH' | 'MEDIUM' | 'LOW', intent: SearchIntent) {
  const anchors = matchedPrimaryDomainAnchors(text, context)
  const procedure = context.questionType === 'PROCEDURE' && intent === 'PROCEDURE'
    && defendantIdentification(context.question) && defendantIdentification(text)
  const reason = importance !== 'HIGH' ? 'NOT_HIGH' as const : anchors.length ? 'DOMAIN_RETAINED' as const
    : procedure ? 'PROCEDURE_EXCEPTION' as const : context.normalizedDomains.length ? 'FINAL_QUERY_DOMAIN_LOST' as const
      : 'QUESTION_DOMAIN_UNRECOGNIZED' as const
  return { valid: reason === 'NOT_HIGH' || reason === 'DOMAIN_RETAINED' || reason === 'PROCEDURE_EXCEPTION', reason, anchors }
}

/** Preserve valid aliases; repair a generic model draft using only the owning question's domain. */
export function formulateContextPrimaryQuery(text: string, context: DerivedDomainContext, intent: SearchIntent): string {
  const query = canonicalizeQueryFormulation(text)
  if (validatePrimaryDomainQuery(query, context, 'HIGH', intent).reason === 'PROCEDURE_EXCEPTION') return query
  if (!context.normalizedDomains.some(f => domainFamilies.some(known => known.canonical === f.canonical))) {
    return formulatePrimaryQueryWithAnchors(query, context)
  }
  const matched = matchedPrimaryDomainAnchors(query, context)
  const family = context.normalizedDomains[0]
  const preferred = family && (context.relationshipAnchors.find(a => family.aliases.some(alias => a.includes(alias)))
    ?? family.canonical)
  return formulatePrimaryQueryWithAnchors(query, { ...context,
    relationshipAnchors: matched.length ? [] : preferred ? [preferred] : context.relationshipAnchors,
    domainAnchors: matched.length ? [] : preferred ? [preferred] : context.domainAnchors,
  })
}
