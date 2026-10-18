import type { LegalQuestionType } from '../legalQuestion/legalQuestionSchema.js'

// Closed lexical transformations, not legal inference or a synonym dictionary.
// Only remove the listed grammatical words BETWEEN an explicit concept pair.
// Never delete negation, punctuation, facts or names, or join separate clauses.
const grammar = '(?:(?:是否|能否|可否|如何|可以|应当|需要|的)){1,3}'
const patterns = [
  new RegExp(`(合同)${grammar}(成立|履行|解除)`, 'gu'),
  new RegExp(`(借款|押金|预付款)${grammar}(返还)`, 'gu'),
  new RegExp(`(租金|货款)${grammar}(支付)`, 'gu'),
  new RegExp(`(损失)${grammar}(赔偿)`, 'gu'),
]

/** Shared by the prompt and validator; derived only from this question. */
export function groundedFallbackExpressions(question: string): string[] {
  return [...new Set(patterns.flatMap(pattern =>
    [...question.matchAll(pattern)].map(match => match[1] + match[2]),
  ))]
}

// Closed, cross-case vocabulary for the legal relationship or dispute subject.
// Every returned anchor must already occur in the owning LegalQuestion.
const prepaidDomainAnchorTerms = ['预付式消费', '预付式服务', '预付费服务', '预付费', '预付卡'] as const
const domainAnchorTerms = [
  ...prepaidDomainAnchorTerms, '预付款', '服务合同', '服务关系', '私教课',
  '民间借贷', '借款合同', '借款',
  '房屋租赁', '租赁合同', '租赁', '押金', '租金',
  '买卖合同', '买卖', '货款',
  '劳动合同', '劳动关系', '工资',
  '交通事故', '侵权责任', '财产损害',
  '物业服务', '保险合同', '保证合同', '担保合同', '定金',
  '承揽合同', '委托合同', '赠与合同', '合伙合同',
] as const
const knownDomainAnchorTerms = new Set<string>(domainAnchorTerms)
const narrativeServicePrefix = /^(?:(?:使用|付款|未知|请求|要求)的)+/u

function canonicalServiceAnchor(anchor: string): string {
  return domainAnchorTerms
    .filter(term => term.endsWith('服务') && anchor.includes(term))
    .sort((left, right) => right.length - left.length)[0]
    ?? anchor.replace(narrativeServicePrefix, '')
}

/** Domain anchors must occur in the owning question. */
export function legalDomainAnchors(question: string): string[] {
  const anchors = domainAnchorTerms.filter(anchor => question.includes(anchor)) as string[]
  // Keep specific service relationships such as 摄影服务合同 or 家政服务纠纷.
  for (const match of question.matchAll(/([\p{Script=Han}]{2,6}服务)(?:合同|纠纷)/gu)) {
    const anchor = canonicalServiceAnchor(match[1])
    if (!anchors.includes(anchor)) anchors.push(anchor)
  }
  return anchors.sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0))
}

const claimOnlyDomainAnchors = new Set(['预付款', '押金', '租金', '货款', '工资', '定金'])

/** Prefer a legal relationship over the requested payment object when one is explicit. */
export function legalRelationshipAnchors(question: string): string[] {
  return legalDomainAnchors(question)
    .filter(anchor => !claimOnlyDomainAnchors.has(anchor))
    .filter(anchor => knownDomainAnchorTerms.has(anchor) || !/^[在对将由与和及于]/u.test(anchor))
}

/** Provider-neutral canonical domain derived from the shared closed vocabulary. */
export function canonicalLegalDomain(text: string): string | undefined {
  const anchor = legalRelationshipAnchors(text)[0]
  return anchor && prepaidDomainAnchorTerms.some(term => anchor.includes(term)) ? '预付式消费' : anchor
}

export function hasLegalDomainAnchor(text: string, question: string): boolean {
  return legalDomainAnchors(question).some(anchor => text.includes(anchor))
}

// Request/dispute actions are shared across case categories. Relationship words
// alone (e.g. 服务合同) do not distinguish the research target.
const disputeActions = [
  '退款', '退费', '退还', '返还', '偿还', '还款', '支付', '交付',
  '逾期', '违约', '赔偿', '解除', '终止', '履行', '成立',
] as const

// A specific payment/return object can itself name a claim in a performance or
// refund question. Reuse the existing domain vocabulary; do not infer synonyms.
const claimObjects = ['租金', '货款', '押金', '工资', '定金'] as const

export function disputeAnchors(question: string, questionType: LegalQuestionType): string[] {
  // A claim assumed successful is a premise, not a contract-formation dispute.
  // Keep other occurrences, including a formation question in the same sentence.
  const disputeText = question
    .replace(/(?:^|[。！？!?；;\n，,])(?:若|如果|假如|假设|倘若|只要)[^。！？!?；;\n，,]{0,200}?(?:诉讼请求|请求|主张|诉请|抗辩|意见)(?:是否|能否|可以|不|未)?成立(?=[，,])/gu,
      premise => premise.slice(0, -2))
    .replace(/(?:诉讼请求|请求|主张|诉请|抗辩|意见)(?:不|未)?成立(?=的?(?:前提|条件)下[，,])/gu,
      premise => premise.slice(0, -2))
  const actions = disputeActions.filter(action => disputeText.includes(action)) as string[]
  if (questionType === 'REFUND' || questionType === 'CONTRACT_PERFORMANCE') {
    actions.push(...claimObjects.filter(object => question.includes(object)))
  }
  return actions
}

export function hasDisputeAnchor(text: string, question: string, questionType: LegalQuestionType): boolean {
  return disputeAnchors(question, questionType).some(anchor => text.includes(anchor))
}

/** Remove only request/controversy framing; preserve relationship, action and object words. */
export function canonicalizeQueryFormulation(text: string): string {
  // ponytail: keep this closed lexical list; expand only with reviewed equivalent framing.
  return text.trim()
    .replace(/^(?:要求|请求)(?=退款|退费|退还|返还|偿还|还款|支付|交付|赔偿|解除|终止|履行)/u, '')
    .replace(/(?:的?(?:请求|争议)|要求)$/u, '')
}

function joinWithOverlap(left: string, right: string): string {
  if (left.includes(right)) return left
  if (right.includes(left)) return right
  for (let size = Math.min(left.length, right.length); size > 0; size--) {
    if (left.endsWith(right.slice(0, size))) return left + right.slice(size)
  }
  return left + right
}

/** Deterministically add only anchors already grounded in the owning question. */
export function formulatePrimaryQuery(
  text: string,
  question: string,
  questionType: LegalQuestionType,
): string {
  return formulatePrimaryQueryWithAnchors(text, {
    relationshipAnchors: legalRelationshipAnchors(question), domainAnchors: legalDomainAnchors(question),
    disputeAnchors: disputeAnchors(question, questionType),
    allowedFallbackExpressions: groundedFallbackExpressions(question),
  })
}

export type PrimaryQueryAnchors = Readonly<{
  relationshipAnchors: readonly string[]
  domainAnchors: readonly string[]
  disputeAnchors: readonly string[]
  allowedFallbackExpressions: readonly string[]
}>

/** Same formulation rules, consuming an already derived owning-question snapshot. */
export function formulatePrimaryQueryWithAnchors(text: string, anchors: PrimaryQueryAnchors): string {
  let query = canonicalizeQueryFormulation(text)
  const relationships = anchors.relationshipAnchors
  const domains = anchors.domainAnchors
  if (relationships.length && !relationships.some(anchor => query.includes(anchor))) {
    query = joinWithOverlap(relationships[0], query)
  } else if (!domains.some(anchor => query.includes(anchor)) && domains.length) {
    query = joinWithOverlap(domains[0], query)
  }
  if (!anchors.disputeAnchors.some(anchor => query.includes(anchor))) {
    const expression = anchors.allowedFallbackExpressions
      .find(item => anchors.disputeAnchors.some(anchor => item.includes(anchor)))
    const dispute = expression ?? anchors.disputeAnchors[0]
    if (dispute) query = joinWithOverlap(query, dispute)
  }
  return query
}
